# Phase 2 剩余缺口修复计划

- 状态:待实施
- 编制日期:2026-08-06
- 来源:对当前源码(`main` @ `3430a5a`)与 `docs/phase2-common-nodes-implementation-plan.md`、`verification/phase2/preflight.md` 的逐项核对 review
- 目标:关闭 Phase 2 Gate 的全部剩余条件;不引入 Phase 3 范围

## 0. Review 结论摘要

Phase 2 数据模型与 Core 事务层(WP1–WP4)已完整落地:8 种 NodeKind、Reparent/成环检测/空 Group 解散、`relativeTransform` 含 Hash 与可逆性校验、全 8 种 StrokeCap、四边 Weight、Paint Stack(≤16 层)、四角圆角/Corner Smoothing/ArcData、Frame Constraints 均已贯通 Core → Protobuf → WASM → Worker → Inspector,并有服务端重放覆盖。

剩余缺口分四类,按优先级列于下文第 2–5 节:

| 优先级 | 类别 | 条目数 |
| --- | --- | --- |
| P0 | 验收矩阵硬性缺口(计划承诺、两份进度文档均未记录) | 4 |
| P1 | preflight 已自认的未过 Gate | 6 |
| P2 | 文档与实现偏差(需更新文档或补决策记录) | 4 |
| P3 | 环境与流程修复 | 2 |

Phase 2 后续工作包(Polygon/Star/Vector/Pen、Radial/Angular/Image Paint、BlendMode/Effect、Auto Layout、PNG/PDF 导出)与 Phase 3/4 范围不在本文档内。

## 1. 验证现状基线(2026-08-06 实测)

- `cargo test -p editor-core -p editor-wasm -p makefigma-document-codec -p makefigma-document-service`:通过(core ≈76、wasm 35、codec 1、service 8)。
- `pnpm test`:438 项中 431 通过;**7 项失败全部为证据采集测试**,根因是采集脚本依赖 `rg`(ripgrep)而本机未安装(见 P3-1),非产品代码缺陷。
- `pnpm check:boundaries`:通过(228 源文件);workspace 目录 API 已迁出前端到独立进程 `services/workspace-api`(见 P1-6),边界规则未放宽。

## 2. P0:验收矩阵硬性缺口

### P0-1 节点级 Copy/Paste 完全缺失

- **现状**:全 `src/` 无剪贴板逻辑;`src/lib/editor-key-command.ts` 仅处理 z/g/d/Backspace/Delete。只有 ⌘D Duplicate。
- **为什么是 P0**:计划 4.2 节 Supported 定义要求 "Copy、Duplicate、Delete、Undo、Redo 可用";第 12.1 节验收矩阵对全部六种节点标记"必须";WP6 "纯键盘完成全流程" 因此无法闭环。
- **实施要点**:
  1. 在 `editor-key-command.ts` 增加 ⌘/Ctrl+C / X / V 解析;与现有 duplicate 一致,由 Worker 解析为 Canonical 命令,保证按钮/键盘同一事务语义。
  2. 剪贴板载体建议用应用内内存 + `navigator.clipboard` 写入自定义 JSON(带 schema version 与 fixture hash),避免跨文档粘贴绕过资产授权;跨文档粘贴时图片资产按 AssetId 引用重校验,不可携带原始字节。
  3. 复制以选中根节点为单位,复用 Duplicate 的子树递归、新 ID 与 parentId 重映射逻辑(计划第 34 行描述的语义);粘贴目标父级为当前选中容器或 Page 根,越界/循环由 Core 既有校验拒绝。
  4. Cut = Copy + 同一事务的容器删除批次。
- **验收标准**:六种节点 + 嵌套容器子树的 Copy/Paste/Cut 在同文档、跨 Page、Undo/Redo、服务重放后 Hash 一致;粘贴后仅选中新根节点;键盘全流程(创建→选择→复制→粘贴→删除)无鼠标可完成;新增单测 + 浏览器 fixture 复核。
- **涉及文件**:`src/lib/editor-key-command.ts`、`src/lib/transaction-batch.ts`、`src/workers/editor.worker.ts`、`src/components/editor/editor-shell.tsx`。

### P0-2 `SceneNode` 缺少 `extensions` 未知数据保留

- **现状**:`schemas/proto/editor/v1/editor.proto` 的 `SceneNode`(229–275 行)没有 `map<string, bytes> extensions`;Page/Document 级 extensions 字段存在但 codec 恒写 `Default::default()`(`crates/document-codec/src/lib.rs:59,71`),从不读回。Rust `Node` 结构体同样无保留字段。
- **为什么是 P0**:计划 7.1 节明确要求;验收场景 15("未知 Phase 3 Node 以 Extension Payload 保留,不被改写")无法满足。这是持久化契约,越晚补,存量文档越多、迁移代价越大。
- **实施要点**:
  1. `SceneNode` 追加 `map<string, bytes> extensions = 38;`(下一个可用字段号,append-only)。
  2. Rust `Node` 增加 `extensions: BTreeMap<String, Vec<u8>>`(BTreeMap 保证 Hash 确定性);进入 `hash_node`,空 map 不写入以保持旧 Hash 兼容。
  3. codec / operation_adapter / core_snapshot_adapter / WASM 投影全部往返该字段;浏览器投影只读透传,不进入 Inspector。
  4. Page/Document 级 extensions 同步接通读回,或明确 ADR 声明其为保留字段。
- **验收标准**:带 extensions 的节点经 Snapshot 保存/恢复、Operation 重放、Undo/Redo 后逐字节保留;新增 Rust 往返测试断言 payload 逐字节相等 + Hash 稳定。
- **涉及文件**:`schemas/proto/editor/v1/editor.proto`、`crates/editor-core/src/lib.rs`、`crates/document-codec/src/lib.rs`、`crates/document-service/src/operation_adapter.rs`、`crates/editor-wasm/src/lib.rs`、`packages/protocol-types`。

### P0-3 旧客户端遇未知 NodeKind 的降级语义

- **现状**:`parse_kind`(`crates/editor-wasm/src/lib.rs:2242-2253`)对未知 kind 返回 `UNSUPPORTED_NODE_KIND`,整体硬拒绝快照;codec 对 `NODE_KIND_UNSPECIFIED` 返回 `SnapshotError::Invalid`。满足"不改写为 Rectangle"的底线,但不满足计划 7.3 节"明确拒绝编辑或进入只读"的优雅降级。
- **实施要点**:与 P0-2 同一工作包。方案 A(推荐,工作量小):保持整体拒绝,但错误必须向用户呈现"文档包含更新版本的节点,当前客户端进入只读"而非静默失败,并禁止在该状态下写入任何 Operation;方案 B(完整):引入 `NodeKind::Unknown(ExtensionPayload)`,渲染为占位框、禁止编辑、往返保留。二选一需先补 ADR。
- **验收标准**:构造含未来 NodeKind 的 Snapshot fixture;客户端加载后不崩溃、不改写、不产生 Operation;UI 有明确只读提示;测试固化该行为。
- **涉及文件**:`crates/editor-wasm/src/lib.rs`、`crates/document-codec/src/lib.rs`、`src/workers/editor.worker.ts`、`src/components/editor/editor-shell.tsx`,新增 `fixtures/documents/` fixture。

### P0-4 缺 v16–v19 Snapshot 迁移 fixture

- **现状**:迁移回归(`crates/editor-wasm/src/lib.rs:3716-3771`)只覆盖 v13/14/15;`fixtures/documents/` 无 v16–v19 fixture 文件;`phase1-snapshot-fixture-manifest.json` 的 `currentSchemaVersion` 仍为 15,已相对 v19 过时。
- **为什么是 P0**:Phase 2 自己引入的 v16(StrokeCap)、v17(corner_radii)、v18(corner_smoothing)、v19(paint stack)没有任何跨版本回归证据;计划 7.3 节要求"读取所有 v1–当前版本 Snapshot Fixture"。
- **实施要点**:
  1. 为 v16/v17/v18/v19 各冻结一份最小但覆盖该版本新字段的 fixture(含 canonical hash 断言),命名与既有 `phase1-snapshot-v{13,14,15}.fixture.json` 一致(建议 `phase2-snapshot-v{16..19}.fixture.json`)。
  2. manifest `currentSchemaVersion` 升到 19,并在 `verify` 脚本中断言 manifest 与 `snapshot_json` 输出版本一致,防再次漂移。
  3. 补一条专门测试固化"透明旧 Paint 迁移后保留为透明 Paint、不变为空数组"(计划 7.2 节冻结规则;实现已存在于 `parse_css_color`,缺测试)。
- **验收标准**:v1–v19 全部 fixture 迁移到当前投影、往返 Hash 一致、重复迁移幂等;透明 Paint 规则有具名测试。
- **涉及文件**:`fixtures/documents/`、`crates/editor-wasm/src/lib.rs`(测试)、`scripts/verify-phase1-snapshot-fixtures.mjs`。

## 3. P1:preflight 已自认的未过 Gate

### P1-1 Stroke 单一几何来源收口(WP5 核心剩余)

- **现状**:`crates/editor-core/src/geometry.rs` 已提供 polyline/dashed/rounded-rect/corner-smoothing/per-side 网格,Canvas 主要路径已消费;但 (a) cap 网格只有 Butt/Round/Square(`geometry.rs:68-72,944-970`),ArrowLines/ArrowEquilateral/Diamond/Triangle/Circle 端点装饰由 Canvas(`src/workers/editor.worker.ts:2088-2140`)与 SVG(`src/lib/svg-export.ts:79`)各画一套;(b) 圆角/平滑角的四边独立 Weight、图片填充路径、SVG 导出未统一消费 Rust 网格;(c) WebGPU 只覆盖 uniform stroke/圆角的 Center/Outside。
- **为什么是 P1**:这是计划 14.4 节点名的"Stroke 多实现漂移"风险,也是 Gate "Stroke Align/Cap/Join/Dash/Miter 在渲染、命中和导出中一致"的直接阻塞项。
- **实施要点(建议切片顺序)**:
  1. 切片 A:在 `geometry.rs` 增加五种装饰 cap 的确定性网格(箭头两种、菱形、三角、圆点),经 WASM 暴露;Canvas 端点装饰与精确 Hit Test 改为消费该网格;SVG 的 marker 输出改由同一网格生成路径。
  2. 切片 B:圆角/Corner Smoothing 的四边独立 Weight 进入 Core 中心线计算(现有 per-side 直角实现的推广),移除该场景的 Canvas 专属降级。
  3. 切片 C:SVG 导出的对齐描边(Paint Ring/虚线中心线/四边)全部改为消费 Rust 网格或由网格推导的路径,删除导出器内的重复几何。
  4. Outline Stroke 用户操作(计划 WP5 交付物,当前全仓无实现)基于同一网格提供 `stroke → fill path` 转换;若决定移出 Phase 2 范围,必须在计划文档与兼容矩阵中显式降级记录,不得静默跳过。
- **验收标准**:计划 12.2 节场景 9–12(箭头 Hit Bounds、三种 Align 一致性、Join/Miter 退化、奇偶 Dash/极短/极粗)在 Canvas、Hit Test、SVG 三端由同一网格驱动并有 Golden 对照;`stroke_hits_polyline` 与渲染网格保持同源(已有基础)。
- **涉及文件**:`crates/editor-core/src/geometry.rs`、`crates/editor-wasm/src/lib.rs`、`src/workers/editor.worker.ts`、`src/lib/hit-test.ts`、`src/lib/svg-export.ts`。
- **状态(切片 A/B/C 已完成)**:
  - 切片 A:`geometry.rs` 新增 `decorative_cap_mesh`(ArrowLines/ArrowEquilateral/TriangleFilled/DiamondFilled/CircleFilled 的确定性三角网格,`size = max(8, strokeWidth·4)`),经 `decorative_cap_mesh_json` 暴露;因 Hit Test / SVG 为无 WASM 的纯 TS 库,按 `line-stroke-outline.ts` 先例新增与 Rust 精确同值的纯 TS 源 `src/lib/decorative-cap-mesh.ts`(以 golden 值对 Rust parity 测试锁定),由 Canvas 端点装饰(`renderLineEndpoint`)、精确 Hit Test 与 SVG 导出三端共同消费;SVG 由填充三角网格路径取代独立 `<marker>`。
  - 切片 B:移除 `canonicalPerSideRectangleStrokeMeshes` 的圆角/Corner Smoothing 早退降级。per-side 模型本就是四条无角接的直线中心线,圆角轮廓仅由调用方 Inside 裁剪施加(与旧 Canvas 降级同一 `roundedRectPath` 裁剪),故圆角/平滑角 per-side 现由同一 Core 中心线网格驱动,不再走 Canvas 专属路径。
  - 切片 C:对齐圆角描边的 inset/outset 角半径推导原本在导出器内联(未归一化)、Worker 私有 `insetCornerRadii`/`outsetCornerRadii`、Hit Test 内联三处各写一套,现统一为共享且 parity 测试的 `src/lib/aligned-rounded-rect.ts`(resolve→shift→resolve 归一化),由 Canvas 渲染、SVG 导出与 Hit Test 三端消费,删除重复几何。per-side 中心线与椭圆环早已分别消费共享 `per-side-stroke.ts` / `ellipse-stroke-ring.ts`。
  - Outline Stroke 用户操作:全仓无实现,经评估**明确移出 Phase 2 范围**(留待 WP5 后续),已在 `docs/compatibility-matrix.md` 的 Frame/Rectangle/Ellipse/Text 与 Group/Line/Arrow/Section 两行显式降级记录,不作静默跳过。
  - 测试:Rust core 91 通过;JS 462 通过(新增 `aligned-rounded-rect` 5 例 parity + `decorative-cap-mesh` parity + SVG per-corner golden)。Golden/perf 重采与独立审核归入 P1-3(源码冻结后)。

### P1-2 Mixed Inspector 完整 NotApplicable 能力矩阵(WP6 收尾)

- **现状**:能力函数(`src/lib/inspector-capabilities.ts`)与主要多选组合已有实现和测试;缺完整组合矩阵的端到端验收与可访问性(屏幕阅读器)验收。
- **实施要点**:以 8 种 NodeKind 的组合等价类(同构、含 Group、含 Section、含 Line、含 Arc、含 Text)为行、以能力字段为列生成表驱动测试,固化每格 Same/Mixed/NotApplicable;补屏幕阅读器 live region 的端到端脚本验收。
- **验收标准**:表驱动测试全绿;人工/脚本化 a11y 验收记录归档 `verification/phase2/`。
- **状态(已完成,独立 AT 复核待冻结)**:
  - 单一来源 tri-state 解析器 `src/lib/inspector-capability-matrix.ts`:`inspectorCapabilityMatrix(nodes)` 合并「适用性」(`mixedInspectorCapabilities`)与「取值一致性」(`mixedSelectionValue` 逐字段摘要)为每格 `same/mixed/notApplicable`;`inspectorCapabilityAnnouncement(nodes)` 由同一矩阵派生屏幕阅读器语句,杜绝朗读与可见 Inspector 漂移。
  - 表驱动矩阵测试 `src/lib/inspector-capability-matrix.test.ts`:行 = 8 种 NodeKind 组合等价类(空选区、同构单选、含 Group/Section/Line/Arc/Text/Image 敌对混选、逐列取值分歧变体),列 = 9 个能力字段(fill/strokeWidth/strokeAlign/perSideStroke/corners/strokeDetails/lineStroke/frameClip/sectionContents),固化每格 Same/Mixed/NotApplicable 并断言三态封闭。**28 项全绿**。
  - live region 接线 `editor-shell.tsx`:多选 `.selection-title` 为 `role="status" aria-live="polite"`,`data-selection-capabilities` 与 `.visually-hidden` 文本同源自 `inspectorCapabilityAnnouncement`;`.visually-hidden` helper 入 `globals.css`。
  - 脚本化 a11y 端到端验收:`scripts/capture-phase2-inspector-a11y-evidence.sh`(经真实 LayerPanel 行构造 Frame+Text 敌对混选,读取 live region 并断言 role/aria-live/朗读一致性 + 计数/编辑/Mixed/NotApplicable 子句 + console 0 error)、`write-phase2-inspector-a11y-evidence.mjs`(产出 `makefigma-phase2-inspector-a11y-evidence-v1` 元数据 + SHA-256 + `signOff.status=pending-independent-review`)、`capture-phase2-inspector-a11y-evidence.test.mjs`(伪 worker 端到端 + 反向断言丢句必非零退出)**2 项全绿**;npm 入口 `pnpm evidence:phase2-inspector-a11y`。
  - 验收记录 `verification/phase2/p1-2-inspector-capability-a11y.md`。**待办**:在装有真实 Playwright CLI 的环境运行 `pnpm evidence:phase2-inspector-a11y`,交独立审核者以真实屏幕阅读器复听、签署冻结 baseline(与 P1-3 独立审核步骤同批)。

### P1-3 Golden 与性能 Gate:源码冻结后重采 + 独立审核

- **现状**:现有候选(`output/phase2-common-nodes/20260806T041922Z/`、`stability-20260806T014459Z/`)均为 `local-candidate`;且采集之后源码又改了 Stroke 网格,按 preflight 自身规则该候选已失效。
- **实施要点**:P1-1 完成、源码冻结后,重跑 `pnpm evidence:phase2-common-nodes` 与 `pnpm evidence:phase2-common-nodes-stability`(3,600 秒);提交独立审核者冻结 baseline 后方可计入 Gate。**依赖 P3-1 先修复 `rg` 环境问题**。
- **验收标准**:console 0 error;Render/Input-to-render/输入队列 P95 低于阈值(12/50/32 ms);独立审核签署记录进入 `verification/phase2/`。
- **状态(采集完成,独立审核待冻结)**:源码冻结(P1-1 收口 + 重建 WASM 桥接 + 生产构建通过,路由表已不含 `/api/workspaces`)后重采:
  - Golden/性能候选 `output/phase2-common-nodes/20260807T030452Z/`:console 0 error;3 次采样中位 Render P95 **1.61 ms** / Input-to-render P95 **19 ms** / Input backlog P95 **16.95 ms**,三项 Gate 全 `true`;`golden.status = pending-independent-review`(`requiresReviewerFreeze: true`)。
  - 稳定性候选 `output/phase2-common-nodes/stability-20260807T030820Z/`:3,600 秒、146 周期连采,console 0 error,中位 Render P95 **2.1 ms** / Input-to-render P95 **24 ms** / Input backlog P95 **17.745 ms**,三项 Gate 全 `true`。
  - 旧候选(`20260806T041922Z`、`stability-20260806T014459Z`)已按 preflight 规则失效,本轮取代。验收记录 `verification/phase2/p1-3-golden-and-performance-gate.md`。**待办**:独立审核者复核像素策略与三项 Gate、签署并冻结 `golden.status`/baseline(与 P1-2 AT 复核同批,不得由采集者自签)。

### P1-4 `DeleteSubtree` 原子性证据补强

- **现状**:子树删除由 TS 层(`src/lib/transaction-batch.ts:40-58`)展开为子节点优先的多条 `DeleteNode`,同一事务提交;Core `Delete` 仍要求无子节点。语义可用,但"原子性由 TS 排序保证"缺乏 Core 级不变量。
- **实施要点**:二选一并记录 ADR:(a) 维持现状,但在 document-service 增加"同一事务内容器删除必须携带完整后代"的服务端校验 + 回归测试;(b) 在 Core 增加 `DeleteSubtree` 命令,TS 层退化为单命令。推荐 (a),改动面小。
- **验收标准**:构造"漏发后代的恶意/缺陷批次"fixture,服务端与 Core 均拒绝;删除多层容器 Undo 后 ID/顺序/属性完全恢复(计划 12.2 场景 5)。
- **状态(已完成)**:采纳方案 (a),记录于 `docs/adr/0024-delete-subtree-atomicity.md`。`core_snapshot_adapter.rs` 在提交 Core 前执行 `validate_delete_subtree_completeness`(按"批次后有效父节点"判定,兼容把后代 reparent 出待删子树的情形),漏删后代的批次在任何变更前被拒。回归测试:document-service 3 例(漏删直接子节点/漏删更深后代被拒、reparent 出子树后接受、完整 child-first 子树删除经全服务边界接受且不留残留),editor-core `deleting_a_multi_level_frame_subtree_is_atomic_and_fully_restored_by_undo`(场景 5,Undo 后 Hash/ID/顺序/父级/属性完全恢复)。

### P1-5 Constraints 传播算法的专项单测确认

- **现状**:`geometry_for_constraints`(`crates/editor-core/src/lib.rs:3367-3386`)实现完整,但 review 抽样未见以该函数为对象的具名单测;计划 6.2.1 节列有最低验收 fixture 清单。
- **实施要点**:逐项补齐计划 6.2.1 的最低验收 fixture:五种轴组合 × 普通/旋转/显式矩阵 Frame、显式矩阵 Group descendant 回投、含 Clip、reparent 后保留、零尺寸 SCALE 拒绝、旋转 Frame 下 Legacy child 不变、重放/Undo 后 Hash 一致。
- **验收标准**:上述 fixture 全部有具名测试并通过。

### P1-6 前端部署边界:workspace Route Handler 迁移

- **现状**:`pnpm check:boundaries` 拒绝 `src/app/api/workspaces/[workspaceKey]/route.ts`(Next Route Handler 承载业务 API,违反"业务 API 位于独立后端"规则)。
- **实施要点**:将 workspace 目录服务迁入 `services/`(与 mock-backend 同级的独立进程)或现有 Rust document-service;或走架构决策明确豁免并更新边界规则。不得放宽检查掩盖。
- **验收标准**:`pnpm check:boundaries` 通过,或 ADR 批准的规则更新与豁免清单一致。
- **状态(已完成)**:采纳「迁入 `services/`」方案。新增独立进程 `services/workspace-api/server.mjs`(`createWorkspaceBackend`),把原 Route Handler 的持久化、按 key 写序列化、跨进程目录锁、乐观并发(`if-match` → 409 返回当前目录)语义逐条搬移;`GET/PUT /v1/workspaces/:workspaceKey` + `/health` 契约端点,请求体 8 MiB 上限防内存耗尽。前端 `src/lib/workspace-store.ts` 改经 `NEXT_PUBLIC_WORKSPACE_API_URL ?? "/workspace-api"` 同源代理(与 document-api/asset-api 同构),`next.config.ts` 新增 `/workspace-api/:path*` rewrite(默认 `http://127.0.0.1:8790`,`MAKEFIGMA_WORKSPACE_API_TARGET` 可覆盖)。删除 `src/app/api/workspaces/[workspaceKey]/route.ts`(`src/app` 下已无 `api/` 与任何 Route Handler)。`package.json` 增 `workspace:api` / `workspace:api:check`,CI `verify.yml` 与其余独立后端并列校验。测试:`services/workspace-api/server.test.mjs` 7 例(健康契约、seed 读、if-match 递增并持久化、stale 409 回current、未知 key 404、坏体 400、无隐式写面),全套 `pnpm test` 130 文件 / 500 项全绿;`pnpm check:boundaries` 通过且**未放宽任何规则**(228 源文件)。验收记录 `verification/phase2/p1-6-workspace-api-boundary.md`。

## 4. P2:文档与实现偏差(更新文档/补 ADR,不改行为)

| # | 偏差 | 动作 |
| --- | --- | --- |
| P2-1 | 计划 7.1 节字段号表(fills=22 等)与 `editor.proto` 实际(fills=35、strokes=36 等)不符 | 更新计划文档字段号表为实际值,注明 22–34 已被更早的 stroke/几何字段占用 |
| P2-2 | 计划要求 `StrokeProperties`/`NodeProperties` 聚合子消息,实际平铺进 `SceneNode`/`AppearanceUpdate` | 补一段 ADR/决策记录说明平铺为最终形态,防后续误"纠偏"造成破坏性变更 |
| P2-3 | 计划 8.1 节要求 `MoveNode` 携带 `page_id` + `relative_transform`,实际 `SetNodeParent` 有意省略、由 reducer 保持世界位置 | 在计划 8.1 节补记实际契约与理由(proto 354–356 行注释已有依据) |
| P2-4 | 计划 8.3 节 `DeleteSubtree` 具名命令 vs 实际 TS 层展开 | 与 P1-4 的 ADR 合并记录 |

- **状态(已完成，2026-08-07)**：以 `schemas/proto/editor/v1/editor.proto` 为单一权威口径校准 `docs/phase2-common-nodes-implementation-plan.md`，四项分歧均已就地记录、不改行为：
  - **P2-1**：§7.1 补「实现现状」段，列出实际字段号（`SceneNode.fills=35`/`strokes=36`/`constraints=37`/`extensions=38`；`AppearanceUpdate.fills=22`/`strokes=23`/`constraints=24`），注明 22–34 已被更早的 stroke/几何字段占用（`stroke_cap_start=22` … `corner_smoothing=34`），并给出实际落地契约的 proto 片段；原始 22/23 提案保留作历史。
  - **P2-2**：新增 [ADR 0025](adr/0025-flattened-appearance-and-structural-operations.md)，冻结「平铺进 `SceneNode`/`AppearanceUpdate` + 现字段号」为最终形态，明确不引入 `StrokeProperties`/`NodeProperties` 聚合子消息，防后续误「纠偏」造成破坏性持久化契约变更。
  - **P2-3**：§8.1 补记实际契约——落地的是 `SetNodeParent`（几何有意省略、reducer 保持世界视觉位置），非携带 `page_id`/`relative_transform` 的 `MoveNodes`；理由与 proto 注释一致。
  - **P2-4**：§8.3 补记子树删除由 TS 层展开为 child-first 多条 `DeleteNode` + 服务端完整性校验实现，非 Core 具名 `DeleteSubtree`，合并引用 [ADR 0024](adr/0024-delete-subtree-atomicity.md)。
  - 校验：`pnpm check:compatibility`、`pnpm check:boundaries` 均通过；无行为/代码变更。

## 5. P3:环境与流程修复

### P3-1 证据采集脚本的 `rg` 依赖

- **现状**:7 个失败测试(phase0/phase1/phase2 各证据采集)全部因 `capture-*.sh` 调用 `rg` 而本机未安装,readiness 轮询失败后超时(实测复现:`scripts/capture-phase2-common-nodes-evidence.sh:32` 报 `rg: command not found`)。
- **实施要点**:二选一:(a) 脚本改用 `grep -E`(POSIX,零依赖,推荐);(b) 脚本开头显式探测 `command -v rg` 并以明确错误信息立即退出,同时在 README 记录依赖。当前"静默轮询 50 次后报超时"的失败形态会误导排查方向,必须消除。
- **验收标准**:在未安装 rg 的干净环境,`pnpm test` 438 项全绿(方案 a)或失败信息明确指出缺依赖(方案 b)。

### P3-2 测试命令的退出码保真

- **现状**:`pnpm test 2>&1 | tail` 类管道会吞掉非零退出码(本次 review 即被此误导过一次)。
- **实施要点**:CI/证据脚本中涉及管道的测试命令统一 `set -o pipefail`;检查 `scripts/capture-*.sh` 与 CI 配置是否已有该保护。
- **验收标准**:人为使一项测试失败,经管道后的采集/CI 步骤仍以非零退出。

## 6. 建议实施顺序与依赖

```text
P3-1(rg 修复,半天内)
  ├── 解锁 P1-3(证据重采)
P0-2 + P0-3 + P0-4(持久化契约包,同一 PR 序列)
P0-1(Copy/Paste,独立 PR)
P1-5(Constraints 单测,独立、可并行)
P1-4(DeleteSubtree ADR + 服务端校验)
P1-1(Stroke 收口,切片 A→B→C,最大工程量)
  └── 完成后源码冻结 → P1-3(Golden/性能/60min 重采 + 独立审核)
P1-2(Mixed 矩阵收尾,可与 P1-1 并行)
P1-6(边界迁移,可独立推进)
P2-*(文档同步,随对应实现 PR 一并交付)
```

全部 P0/P1 关闭、且 P1-3 由独立审核者冻结后,方可按计划第 13 节宣告 Phase 2 常见节点子阶段完成;在此之前兼容矩阵维持现有 Partial 标注。
