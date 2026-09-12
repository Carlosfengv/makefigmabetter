# Phase 2 剩余能力落地计划

- 状态：Draft，已按 2026-08-08 图层类型复核修正范围
- 编制日期：2026-08-08
- 基线：当前本地工作区（`main` @ `3430a5a` 加未提交 Phase 2 remediation 变更）
- 目标：完成架构总纲中 Phase 2.1–2.16，达到“可用于真实 UI 设计任务的专业编辑器 Beta”Gate
- 前置：Phase 1 Gate 已完成；Phase 2 Common Nodes 当前为候选状态，尚未完成独立验收与集成

## 1. 结论与执行边界

当前实现已经完成 Phase 2 的常见节点、层级、基础 Transform、Stroke、Mixed Inspector、Frame Constraints 与 SVG 导出的主要基础，但不能据此宣告完整 Phase 2 完成。

剩余工作分为四条主线：

1. **Phase 2A 收口**：把当前未提交的 Common Nodes 候选变成可复现、可审核、可签署的集成基线。
2. **专业图形能力**：补齐 Polygon、Star、VectorPath、Pen、BooleanOperation、Outline Stroke、Mask 与 Effect。
3. **专业布局与文本**：补齐高级文本编辑、Constraints 边界与 Auto Layout。
4. **交付与验收**：补齐 PNG/PDF 导出、复杂性能 Fixture、Golden 和设计师综合验收。

以下能力不进入本计划：

- Component、Instance、Variant、Variables、Styles 与 Library；
- Plugin Bridge 写回和 Round-trip 兼容；
- 多人 Presence、评论、并发合并与协同 Undo；
- `.fig` 私有文件格式读写。

这些能力继续分别归入 Phase 3 或 Phase 4。

补充（2026-08-16）：原计划中的 Figma REST 导入已由后续阶段决策前置为 Phase 2 的**受限交付兼容能力**，其 Canonical-first 数据契约、字段映射和未支持语义见 `docs/phase2-figma-api-delivery-spec.md` §6。范围只包括不可信 REST JSON 的预检、确定性 Canonical 候选和经既有事务/Asset Service 边界执行的导入；不包含 Plugin 写回、私有 `.fig`、变量/组件 round-trip 或绕过授权的资源下载。

## 2. 不可破坏的工程约束

所有工作包必须遵守以下约束：

1. **Canonical-first**：先完成 Rust Core 数据模型、验证、Hash、Transaction、Undo/Redo，再接 Protobuf、Codec、Service、WASM、Worker 和 UI。
2. **协议只追加**：Protobuf 字段号只追加，不复用、不改语义；Snapshot 版本单调递增，并为每个版本冻结迁移 Fixture。
3. **单一事务语义**：用户一次操作只能形成一个 Canonical Transaction；失败时不得留下半完成结构、孤儿资源或部分效果。
4. **单一几何来源**：Vector、Boolean、Stroke、Mask 和导出共用 Rust 几何与 Tessellation 结果，禁止 Canvas、Hit Test、SVG/PDF 各写一套近似算法。
5. **明确降级**：WebGPU 不支持的节点必须按稳定 z-order 回退 Canvas；不得伪装为已支持，也不得修改 Document 来适应渲染器。
6. **不可信输入隔离**：路径、图片、字体、剪贴板和导出输入均必须有数量、字节、递归深度、控制点和纹理预算。
7. **兼容性可见**：每个 Partial/Unsupported 行为必须进入兼容矩阵和导出报告。
8. **证据不可自签**：Golden、可访问性、60 分钟稳定性和设计师综合验收必须由未参与实现的人冻结或签署。

## 3. 当前基线

### 3.1 已形成闭环

- Frame、Rectangle、Ellipse/Arc/Donut、Text、Image、Line/Arrow、Group、Section 共 8 种 NodeKind；
- 嵌套层级、PositionId、跨父级 Reparent、成环拒绝、Group/Ungroup、子树删除与恢复；
- Relative-v1 仿射变换、单选/多选八方向 Resize、比例锁定、中心缩放、镜像与 Line 端点编辑；
- Fill/Linear Gradient/Paint Stack、Stroke Align/Cap/Join/Dash/Miter、四边 Weight、四角 Radius 与 Corner Smoothing；
- 基础 Drop Shadow Canonical 字段（offset、blur、spread、color、visible），含 Core/WASM/Protobuf/Snapshot、Canvas 2D 与 Inspector 候选闭环；
- Mixed Inspector 主要能力矩阵、图层键盘导航、重命名、层级移动与 selection live region；
- Frame Constraints 的 `min/center/max/stretch/scale`，以及旋转/Relative-v1 Frame 下 Legacy 直接 child 到局部矩阵的事务迁移；
- Snapshot v1–v19 迁移、未知 extensions 保留、未来 NodeKind 只读拒绝；
- Document/Asset/Workspace 独立服务边界；
- SVG 基础导出、Common Nodes Golden/性能/60 分钟本地候选。

### 3.2 当前剩余阻塞

- 当前成果仍位于未提交工作区，尚未形成 CI 可复现的集成基线；
- R1 剪贴板闭环已完成：版本化跨文档/跨标签页载体、schema/Hash 校验、已授权资源的 Asset Service 原子附加、跨 Page 子树重归属、Undo/Redo、断线重放及服务恢复矩阵均已归档；
- Common Nodes Golden、性能与可访问性仍为 `pending-independent-review`；
- 画布旋转控制柄、方向键世界坐标位移（含 Relative-v1）、基础 Shadow、Mixed Inspector 以及核心键盘流程均已完成候选验证；完整 UI Primitive 的跨辅助技术验收仍待独立审核；
- Polygon/Star 已完成参数 NodeKind、协议/快照/重放、基础 Inspector、Rust Core→WASM→Canvas/Hit/SVG/PNG/PDF 的 Fill 轮廓、Canvas Stroke 网格、Rust Fill/Stroke 的空间/选择 Bounds，以及单一 Core 事务的 Convert to Vector 候选链路；嵌套 Star 的旋转、镜像、Undo/Redo 浏览器矩阵已通过，仍待独立审核。Vector 已有 Canonical/协议/快照/服务/WASM、受预算 Rust 几何、Canvas/Hit/SVG 与基础 Inspector 候选链路；画布锚点、控制柄和基础 Pen 已起步。BooleanOperation 已冻结活结构与 Flatten 语义，四种 Rust clipping 已驱动 Canvas/Hit/Flatten/SVG，Flatten/Outline 的事务队列链路已在浏览器通过；复杂操作数、PDF、跨格式与独立恢复验收仍未形成闭环。Slice、Mask、Effect 与 Auto Layout 已各有 Canonical→UI 候选闭环和基础导出，仍缺完整跨格式/Golden/独立恢复验收；
- 高级文本的替换操作保留未编辑 Style Run，Inspector textarea 与画布 `contentEditable` 均可按 UTF-8 边界更新选区样式、复制/剪切/粘贴和原子提交；复杂脚本/IME 与独立屏幕阅读器验收仍待完成；
- `F-PHASE2-PROFESSIONAL-COMPOSITE` 已提供 Auto Layout、两段封装在独立 Group 中的 alpha Mask、Frame Clip、Layer Blur + Drop Shadow 有序组合、图片 fallback 与复杂文本的固定候选输入；该固定 URL 的 Reset demo 会恢复同一份 24 节点、3 资源的 fixture，而非切换至通用演示文档；性能采样、Golden、60 分钟稳定性与设计师验收仍未完成。

## 4. 总体实施顺序

```text
R0 集成与验收基线
  ├─ R1 剪贴板闭环
  ├─ R2 Common Nodes 独立审核
  └─ R3 旋转 / Shadow / UI Primitive 收尾
       ↓
G0 Polygon / Star 参数图形
G1 VectorPath Canonical 与几何内核
  ├─ G2 Pen Tool
  ├─ G3 BooleanOperation + Flatten + Outline Stroke
  └─ G4 Mask / Clip / Hit Test
G5 Slice 导出区域
       ↓
E1 Effect 合成与离屏纹理池
       ↓
L1 高级文本编辑
L2 Constraints 收口
       ↓
L3 Auto Layout
       ↓
X1 PNG / SVG / PDF 导出与兼容报告
       ↓
Q1 复杂性能、Golden、稳定性和设计师综合验收
```

原则上不得在 G1 的 Canonical Path 与资源预算冻结前实现 Pen、Boolean 或 Mask UI；不得在 Auto Layout 语义冻结前把 Hug/Fill 暂存为普通宽高覆盖。

### 4.1 工作包优先级与依赖

Size 仅表示相对工程量，不代表日历工期。

| 工作包 | 优先级 | Size | 直接依赖 | 可并行边界 |
| --- | --- | --- | --- | --- |
| R0 集成基线 | P0 | M | 无 | 必须最先完成 |
| R1 剪贴板闭环 | P0 | M | R0 | 可与 R2 并行 |
| R2 独立审核 | P0 | S | R0、冻结源码 | 可与 R1 并行，但签署必须基于最终源码 |
| R3 Transform/Shadow/A11y | P1 | L | R0 | Shadow Schema 需与 E1 对齐 |
| G0 Polygon/Star | P1 | L | R0、图层类型 ADR | 可与 G1、G5 并行 |
| G1 VectorPath 基础 | P1 | XL | R0 | Core/协议可与 R3 UI 工作并行 |
| G2 Pen Tool | P1 | L | G1 | 点编辑与绘制工具可分切片 |
| G3 Boolean/Outline | P1 | XL | G1 | Outline 可在 Boolean 后半段前交付 |
| G4 Mask/Clip | P1 | L | G1 | 可与 G2/G3 后半段并行 |
| G5 Slice | P1 | M | R0、图层类型 ADR、X1 导出契约 | Canonical/UI 可与 G0/G1 并行 |
| E1 Effect | P1 | XL | R3 Shadow、G4 | Render Graph 与 Inspector 可分切片 |
| L1 高级文本 | P1 | XL | R0、R1 文本剪贴板格式 | 可与 G1–G4 并行 |
| L2 Constraints 收口 | P1 | M | R3 Transform | 应在 L3 前完成 |
| L3 Auto Layout | P1 | XL | L1 文本测量、L2 | 算法切片必须串行演进 |
| X1 导出 | P1 | XL | G3、G4、E1、L1、L3 | PNG 基础设施可提前，最终 Gate 不可提前 |
| Q1 最终验收 | P0 Gate | L | 全部工作包 | 只能在源码冻结后执行 |

### 4.2 Phase 2.1–2.16 追踪矩阵

| 架构步骤 | 剩余状态 | 关闭它的工作包 |
| --- | --- | --- |
| 2.1 Common Nodes | 候选，待集成/审核 | R0、R2 |
| 2.2 嵌套图层树 | 基本完成，随 Common Nodes 冻结 | R0、R2 |
| 2.3 完整 Transform | 缺旋转控制柄和最终键盘流程 | R3 |
| 2.4 外观、Shadow、Mixed Inspector | 缺 Shadow 完整闭环和独立 A11y | R2、R3、E1 |
| 2.5 键盘与可访问 UI | 部分完成 | R1、R2、R3 |
| 2.6 VectorPath | 部分完成：Canonical、Rust 几何与基础消费链路已有候选实现 | G1 |
| 2.7 Pen Tool | 部分完成：点级命令、Inspector、画布锚点/控制柄编辑与开放路径续画已起步 | G2 |
| 2.8 Boolean/Outline/Stroke | 候选闭环：Live Boolean、Flatten 与首批 Vector/Line Outline 已贯通；复杂操作数、跨格式 Fixture 与独立恢复验收待完成 | G3、X1 |
| 2.9 Mask/Clip | 候选闭环：同级 alpha Mask、Frame Clip、两层嵌套、选择裁剪与 SVG/PNG/PDF 来源已接入；像素 Golden、精确 Selection Bounds 与独立恢复验收待完成 | G4、X1 |
| 2.10 Blend/Shadow/Blur | 有序 Drop/Inner Shadow、Layer/Background Blur 与首批 Blend Mode（Normal、Multiply、Screen、Overlay、Darken、Lighten）已在 Core/协议/快照/服务/WASM/Canvas/Inspector 候选闭环；SVG 对该 Blend 子集输出 `mix-blend-mode`。WebGPU 离屏纹理池、PDF 降级与 Golden 仍待 E1 | E1 |
| 2.11 高级文本 | 部分完成 | R1、L1 |
| 2.12 Constraints | 旋转/仿射 Frame 下的 Legacy 直接 child 与完整 Group 子树已迁移，连续 Resize 无漂移且嵌套 Frame 边界保持独立；活跃 Auto Layout Frame 现在独占子层几何，原有 Constraints 保留但不参与计算或 Inspector 编辑 | L2、L3 |
| 2.13 Auto Layout | 候选闭环：Core/协议/快照/服务/WASM/Worker/Inspector 已覆盖单轴、Padding/Gap/Alignment、Hug/Fill、Min/Max、Absolute、固定尺寸 Wrap、三层嵌套和增量 Dirty Set；完整拖拽插入反馈、复杂文本/Wrap 组合与跨导出格式验收仍待 L3/X1 | L3、X1 |
| 2.14 PNG/SVG/PDF | 候选闭环：页面、节点选择与 Slice 已共享冻结 SVG→PNG/PDF 输入、透明 RGBA/alpha-soft-mask 与 sidecar；原生可编辑 vector PDF、复杂 Effect raster 与独立交付验收待完成 | X1 |
| 2.15 复杂性能 Fixture | Common Nodes 与 Professional Composite 固定候选均可打开；性能/Golden/稳定性采集仍待完成 | Q1 |
| 2.16 专业编辑综合验收 | 未执行 | Q1 |

### 4.3 Phase 2 图层类型追踪矩阵

架构总纲 §7.2 的图层类型范围独立于 2.1–2.16 的步骤标题，必须单独追踪：

| Phase 2 NodeKind | 当前状态 | 关闭它的工作包 |
| --- | --- | --- |
| Section | 已有完整链路，待独立验收 | R0、R2 |
| Group | 已有链路；Relative-v1 Bounds 与空 Group 不变量已有候选修复，待跨层冻结 | R0、R2 |
| Line | 已有链路；最短长度固定端点已有候选修复，待浏览器/服务矩阵 | R0、R2 |
| Polygon | Rust Core/WASM 的 Canvas/Hit/SVG/PNG/PDF Fill、Canvas Stroke、Fill/Stroke Bounds 与 Convert to Vector 候选已接入；待完整矩阵 | G0 |
| Star | Rust Core/WASM 的 Canvas/Hit/SVG/PNG/PDF Fill、Canvas Stroke、Fill/Stroke Bounds 与 Convert to Vector 候选已接入；待完整矩阵 | G0 |
| Vector | Canonical/快照/服务/WASM、Rust 几何、Canvas/Hit/SVG 与基础 Inspector 候选链路；基础 Pen/开放路径续画已可用，待高级路径编辑 | G1、G2 |
| BooleanOperation | 活结构、四种 Rust clipping、Canvas/Hit/SVG 与 Flatten/Outline 候选链路已接入；复杂操作数、PDF、跨格式及独立恢复验收待完成 | G3、X1 |
| Slice | 候选闭环：Canonical/编辑、世界区域 SVG、透明 PNG 与多页 PDF；高级交付仍待 G5、X1 | G5、X1 |

详细证据、严重级别与验收口径见 `phase2-layer-types-implementation-review.md`。

## 5. 工作包明细

### R0：集成基线与文档真相收口

**目标**：把当前本地候选变成可由其他开发者和 CI 重现的 Phase 2A 基线。

**实施内容**：

1. 对当前工作区按协议/Core、服务、Worker/UI、证据与文档拆分为可审查提交。
2. 生成协议与 WASM 后验证工作区无意外生成差异。
3. 将 `phase2-common-nodes-implementation-plan.md`、`phase2-remediation-plan.md`、`preflight.md` 和兼容矩阵更新到同一状态口径。
4. 新增 `verification/phase2/completion-checklist.md`，逐项引用自动测试、浏览器证据、审核人与冻结产物。
5. CI 固定执行：前端测试、Rust 核心测试、renderer 测试、协议检查、边界检查、兼容矩阵、Snapshot Fixture、Phase 2 Fixture 和生产构建。

**通过标准**：

- 干净 clone 可一次性通过全部检查；
- 文档不再出现“已完成/未完成”互相冲突；
- 所有生成物与源协议一致；
- 无未解释的删除、临时截图或 `tmp/` 进入提交；
- Common Nodes 仍保持 `NO-GO`，直到 R1、R2 完成。

**主要影响范围**：`.github/workflows/verify.yml`、`docs/`、`verification/phase2/`、协议生成脚本与 WASM 构建脚本。

### R1：跨文档 Copy/Cut/Paste 闭环

**目标**：让节点子树剪贴板在同文档、跨 Page、跨文档和跨标签页场景中保持安全、可预测、可撤销。

**实施内容**：

1. 定义版本化剪贴板格式 `makefigma-node-clipboard-v1`，至少包含：
   - schema version；
   - source document/page ID；
   - root IDs 与 parent-before-child 节点投影；
   -引用的 AssetId、FontId 和必要的内容 Hash；
   - payload SHA-256。
2. Worker 内存继续作为快速路径；浏览器层接入系统剪贴板或可序列化 fallback。
3. 粘贴前验证格式、版本、Hash、节点数、深度、总字节、资源引用和目标容器能力。
4. 同文档资源可直接引用；跨文档资源必须由 Asset Service 重新授权/附加，不得只因 AssetId 相同而默认合法。
5. Cut 仅在 Copy 成功后提交原子 Delete；Paste 失败不改变 selection、history 或 clipboard。
6. 粘贴后只选中新根节点，所有节点获得新 ID，内部父子关系、PositionId 和 Relative Transform 保持稳定。

**测试矩阵**：

- 8 种当前 NodeKind 与多层 Frame/Group 子树；
- 同文档、跨 Page、跨文档、跨标签页；
- 有图像、有字体、无资源、资源缺失和无权限；
- schema 过新、Hash 被篡改、循环父级、超深子树和超预算 payload；
- Copy、Cut、Paste、Undo、Redo、断线重放和服务恢复后的 Document Hash。

**通过标准**：

- 所有场景以一笔事务成功或完全无副作用地失败；
- 不产生未授权 Asset/Font 引用；
- 跨文档/跨标签页通过真实浏览器验收，不只验证纯函数；
- 键盘创建→选择→复制→粘贴→删除流程无需鼠标。

**主要影响范围**：`src/lib/editor-protocol.ts`、`src/lib/transaction-batch.ts`、`src/lib/editor-key-command.ts`、`src/workers/editor.worker.ts`、`src/components/editor/editor-shell.tsx`、Asset/Document API 适配层。

### R2：Common Nodes 独立审核与 Gate 冻结

**目标**：关闭 Common Nodes 子阶段最后的人工 Gate。

**实施内容**：

1. 在冻结源码上重新确认 Common Nodes Golden、三项性能指标和 60 分钟稳定性证据仍匹配源码 Hash。
2. 使用真实 Playwright CLI 重采 Mixed Inspector A11y 证据。
3. 由独立审核者：
   - 检查关键节点视觉、Stroke/Cap/Join/Dash、图片填充和 SVG；
   - 使用桌面屏幕阅读器复听敌对混选；
   - 冻结 Golden baseline 和性能结果；
   - 签署 Common Nodes completion checklist。

**通过标准**：

- Golden 状态不再是 `pending-independent-review`；
- Render P95 < 12 ms、Input-to-render P95 < 50 ms、输入队列 P95 < 32 ms；
- 连续 60 分钟无崩溃、无 console error、无明显内存增长；
- 真实屏幕阅读器播报包含选择数量、Mixed 和 NotApplicable 状态；
- Common Nodes P0/P1 清零。

### R3：Transform、基础 Shadow 与完整键盘 UI 收尾

**目标**：关闭 Phase 2.3–2.5 中仍未完成的基础专业编辑语义。

**实施内容**：

1. 增加画布旋转控制柄，支持单选、多选、Shift 角度吸附、旋转父级、镜像矩阵和 Undo/Redo。
2. 定义基础 Drop Shadow Canonical 模型：offset、blur、spread、color、visible；Effect Stack 的完整顺序在 E1 扩展。
3. Mixed Inspector 增加 Shadow 的 Same/Mixed/NotApplicable 语义。
4. 建立可复用 Menu、Dialog、Tooltip、Toast、Focus Trap 和 Roving Focus Primitive。
5. 键盘覆盖创建、选择、移动、缩放、旋转、重命名、排序、属性编辑、复制粘贴与删除。
6. 所有异步状态播报必须绑定当前 revision，禁止播报已经被撤销或被远端 Snapshot 替换的状态。

**通过标准**：

- 旋转操作无漂移，Undo 精确恢复 Canonical Hash；
- 基础 Drop Shadow 在 Canvas、WebGPU fallback、SVG filter 映射和 Snapshot 中一致；
- 完整基础流程由键盘和至少一种桌面屏幕阅读器完成；
- 焦点在虚拟列表刷新、Dialog 关闭和 Undo/Redo 后不丢失。

## 6. 专业图形工作包

### G0：Polygon 与 Star 参数图形

**目标**：补齐架构 §7.2 明确列出的 `Polygon` 与 `Star` NodeKind，并保留可编辑参数语义。

**前置决策**：通过 ADR 冻结 Polygon `point_count`、Star `point_count/inner_ratio`、角点方向、参数边界、Resize 行为和 Convert to Vector 语义；若决定创建后立即转 Vector，必须同步修改架构总纲，不得保留名义支持。

**实施内容**：

- Canonical Schema、Operation、Snapshot、Hash、Service 和 WASM 投影；
- 创建工具、Layers、Inspector、Copy/Duplicate/Delete/Undo/Redo；
- Rust 生成的 Fill/Stroke 几何、Bounds、精确 Hit Test 和渲染 fallback；
- SVG/PNG/PDF 导出及兼容性报告；
- 参数边界、凹形 Star、旋转/镜像、嵌套与 Convert to Vector Fixture。

**通过标准**：参数在保存、重放和 Undo/Redo 后逐值一致；画布、Hit Test 与导出消费同一生成几何；Convert to Vector 是单一可撤销事务。

**当前候选进度（2026-08-09）**：ADR 0026 已冻结；Core/Proto/快照/服务/WASM 已持久化参数并验证边界与哈希。Rust `parametric_shape_outline` 已生成有界、从顶部开始的顺时针 Fill 轮廓和 Fill Bounds，WASM 桥接已由 Canvas、Worker Hit Test、空间/选择 Bounds 与冻结的 SVG/PNG/PDF 导出消费；Canvas Stroke 复用该轮廓进入 Rust 的闭合折线 tessellator，且含 Stroke 的空间/选择 Bounds 读取其 mesh bounds；GPU 明确回退 Canvas。Convert to Vector 以单一 Core create/delete/reposition 事务替换参数节点，Undo/Redo 恢复两种形态。创建工具与 Inspector 仍保留参数语义；真实浏览器已验证嵌套 Star 的旋转、跨边镜像与 Undo/Redo，G0 仍待独立审核。

### G1：VectorPath Canonical、几何与渲染基础

**目标**：建立 Pen、Boolean、Mask 和 Outline Stroke 共用的路径事实来源。

**Canonical 模型**：

- 新增 `NodeKind::Vector`；
- VectorPath 由一个或多个 Subpath 组成；
- 每个点包含稳定 PointId、position、in/out handle、point type；
- 支持 open/closed、NonZero/EvenOdd Fill Rule；
- 设置控制点、插入、删除、拆分和连接均为具名 Command；
- Path、Subpath、Point 数量和序列化字节均有硬上限。

**实施顺序**：

1. Rust Core 数据模型、验证、Hash、Undo/Redo 和资源预算；
2. Protobuf Snapshot/Operation append-only 扩展，Snapshot 升级并冻结 Fixture；
3. Document Codec、Service reducer、WASM 投影；
4. Rust flattening、bounds、fill/stroke tessellation 和 point/segment hit test；
5. Worker 渲染、选择框、节点命中和锚点编辑 overlay；
6. Inspector 的 Fill Rule、闭合状态与基础 Path 属性；
7. SVG 路径导出。

**测试矩阵**：直线、二次/三次曲线、尖角、平滑点、自交、多子路径、开放路径、空路径、退化 segment、极大坐标、NaN/Infinity、超预算点数。

**通过标准**：

- 保存/恢复后控制点逐值一致；
- Canvas、Hit Test 和 SVG 共用相同 flattening/tessellation 语义；
- 编辑过程中不修改未提交 Canonical Document；
- 退化和恶意路径被确定性拒绝，不崩溃、不无限细分。

**主要影响范围**：`schemas/proto/`、`crates/editor-core/`、`crates/document-codec/`、`crates/document-service/`、`crates/editor-wasm/`、`src/workers/editor.worker.ts`、`src/lib/hit-test.ts`、`src/lib/svg-export.ts`、Inspector。

**当前候选进度（2026-08-10）**：ADR 0027 已冻结。`Vector`、`VectorPath`、稳定 PointId、相对控制柄、Fill Rule、硬资源上限与原子 `SetVectorPath` 已覆盖 Core Hash/Undo/Redo、Protobuf Snapshot/Operation、Document Codec、Service reducer 和 WASM JSON 投影；Core 已提供带瞬态预算的 cubic flatten、局部 bounds、多子路径 fill hit 和 stroke mesh，Worker Canvas、fill/stroke hit 与选择 bounds 优先消费该 WASM 派生几何，SVG 复用同一相对控制柄分段语义。TypeScript 的同源 Canvas 命中回退现在也显式命中闭合填充轮廓边界，并采用与 Core 对齐的最大 24 层递归、262,144 点总预算的自适应 cubic 扁平化；超预算时安全拒绝回退命中。even-odd/non-zero 嵌套绕向、画布入口和极端陡峭曲线回归共同固定，避免边界点或固定采样弦线造成漏选/误选。选中 Vector 会显示可拖拽锚点与控制柄 overlay；基础 Inspector 可更新 Fill Rule 和子路径闭合状态，GPU 保持 Canvas 回退。尚未满足完整通过标准：fill tessellation、全量复杂路径的 Canvas/SVG fallback 一致性、Pen、PNG/PDF、复杂自交与多子路径 Fixture 仍留在 G1/G2 后续切片。

补充（2026-09-12）：普通 Vector 的 Canvas 与冻结 SVG/PNG/PDF 输入直接消费 Canonical authored cubic，由浏览器在目标分辨率原生绘制，避免固定文档容差被放大后形成可见折面。Rust 的受预算 flatten 继续负责 Bounds、Hit Test、Boolean、Stroke Mesh 与 Outline；展示型 Stroke Mesh 使用按 Zoom/DPR 分桶的四分之一设备像素误差预算，Boolean/Outline 等确定性派生不依赖视口。导出不会把派生点写回 Canonical Document。

### G2：Pen Tool 与节点级路径编辑

**目标**：完成连续钢笔绘制和既有 VectorPath 的点级编辑。

**实施内容**：

- 点击加直线点、拖拽创建曲线点；
- 继续绘制、闭合、结束、取消；
- 加点、删点、移动点、移动控制柄、断开/连接柄；
- 连接两个开放端点、拆分 segment、继续既有路径；
- 点/segment 多选、键盘删除与方向键微调；
- 每次用户意图对应合理 History 粒度，拖动期间仅更新瞬态投影。

**通过标准**：

- 按固定操作脚本可临摹一组图标；
- 任意中断点均可退出，不出现工具死锁；
- 最终 Path 与固定 Fixture 完全一致；
- Undo/Redo 不丢 PointId、控制柄或闭合状态。

**当前候选进度（2026-08-10）**：`MoveVectorPoint`、`SetVectorSubpathClosed`、`InsertVectorPoint`、`SplitVectorSegment`、`ConnectVectorEndpoints`、`DeleteVectorPoint` 与 `SetVectorPointHandles` 已成为有 Hash、资源预算、Undo/Redo、WASM batch、Protobuf Operation 和 Service reducer 覆盖的具名 Canonical Command。`SplitVectorSegment` 以参数化 de Casteljau 精确分割直线或 cubic segment，并保留原曲线与控制柄；Inspector 可在选定锚点后以 50% 拆分可用的后续 segment。Inspector 还可按稳定 PointId 编辑锚点 X/Y、在当前锚点后插点、在最小点数约束内删点、设置 point type 与基础 in/out 控制柄，并独立开闭每个 Subpath；画布会显示锚点和相对控制柄，锚点与控制柄均可拖拽，拖动期间仅更新瞬态投影、松开时分别提交一条点移动或控制柄更新 Transaction。点击锚点后现在以高亮的瞬态编辑目标接收方向键：世界坐标的 1px/Shift 10px 位移先按当前仿射变换换回 Vector 本地坐标，再以一条 `MoveVectorPoint` Transaction 提交；Delete/Backspace 会在 Core 的闭合 3 点、开放 1 点下限之上提交 `DeleteVectorPoint`，Esc 只退出锚点编辑。固定浏览器夹具已验证首锚点 X=4→5、Hash r0→r1，以及 Delete 后 4 点→3 点、r1→r2，Reset 后 console 0 error。基础 Pen 已可连续点击落点、拖拽创建镜像控制柄、点击首点闭合、Enter 提交或 Esc 取消；首点落下后，鼠标移动会显示不写入 Document/History/同步的下一段预览：没有出控制柄时为直线，有出控制柄时按该切线显示 cubic 曲线及末端提示。点击选中开放路径的任一端点后可继续绘制，新增点与续画闭合会在同一原子事务中提交。单个 VectorPath 的两个开放子路径现在可通过端点连接为一条路径；Core 会确定性地翻转方向与交换相对控制柄，重合端点合并为一个稳定 PointId，相同子路径的相反端点则闭合该路径。跨 Vector 的首批连接也已可用：同页同容器时，来源的被点击开放子路径会将锚点与相对控制柄转换到当前 Vector 的局部坐标后，由一次事务吸收；来源没有其他子路径则删除，存在其他子路径则只更新并保留该来源图层，当前层始终保留样式和 ID。跨父级和跨页来源仍明确拒绝。选中 Vector 后双击其路径段，会由 Rust 几何内核返回原 cubic 的最近 segment 和参数，再提交单条 Canonical `SplitVectorSegment` Transaction；真实浏览器夹具已验证其从 4 点变为 5 点且 r0→r1，独立浏览器验证两个 2 点 Pen 路径连接后来源层消失、目标为 4 点且 r2→r3。

补充（2026-08-10）：画布锚点支持 Shift 多选同一 Vector 的多个点。方向键将所有所选点以同一 Canonical `MoveVectorPoint` 批次提交；删除前逐个子路径校验闭合至少 3 点、开放至少 1 点。多选属于瞬态编辑状态，Esc 或对象选择变化即清除；浏览器操作后 Reset 的控制台为 0 error。

### G3：BooleanOperation Node、Flatten 与 Outline Stroke

**目标**：实现 `BooleanOperation` NodeKind、Union/Intersect/Subtract/Exclude、Flatten 和 Stroke → Fill Path。

**关键决策**：

- 默认方案为保留 children 的活 `BooleanOperation` 结构，Canonical 只保存 operation 与子树，派生 Path 不写 Snapshot；Flatten 才生成普通 Vector；如选择一次性结果，必须通过 ADR 同步修改架构 §7.2；
- 交互预览和最终提交调用同一 Rust 几何算法；
- Outline Stroke 直接消费已统一的 Stroke Tessellation，不另写近似轮廓算法。

**实施内容**：

1. Rust 侧路径归一化、交点、分割、环分类与 Fill Rule；
2. 相切、包含、重合边、自交、开放路径与零面积输入的确定性语义；
3. Operation、Undo/Redo、服务重放和兼容 Snapshot；
4. UI 命令、禁用态、错误提示和结果选择；
5. Canvas/SVG/PDF 输出同一结果路径。

**通过标准**：

- 固定退化测试集不崩溃、结果可重复；
- 输入顺序规则被明确冻结；
- Boolean/Outline 后的 Path 可继续编辑；
- 保存、刷新、Undo/Redo 和远端重放后 Hash 一致。

**当前候选进度（2026-08-10，2026-08-16 更新）**：四种 live Boolean 已由 Rust clipping 统一驱动 Canvas、命中、Flatten 与 SVG 导出；`Subtract` 继续以层级顺序中的第一个 Vector 为主体。固定退化测试覆盖相切、包含、重合、开放/零面积和自交输入的重复性。Flatten 以一笔 Core create/delete/reposition 批次保留外部层级位置并可撤销；批次会先删除 Boolean operands、再删除 wrapper，避免 Core 的 `NodeHasChildren` 拒绝。编辑器事务队列已与 Flatten/Outline 的结构替换接通。2026-08-10 在固定专业夹具中复验了 `Union → Subtract → Flatten`：运算切换为 r0→r1，Flatten 为 r1→r2，替换结果是可直接编辑的 6 点 Vector，console `0` error。Vector 的无虚线、同 cap（none/round/square）描边可经同一 Rust tessellation + union 转为普通可编辑 Fill Path，并保留同一节点 ID；Line 现可使用不同的标准起止端帽（none/round/square），该组合由 Core 的同一 tessellation、WASM `vector_path_outline_with_caps` 与编辑器替换事务贯通。由于 NodeKind 不可变，Line 会在一个 create/delete/reposition Core 事务中替换为保留世界端点、层级位置和旋转的 Vector；真实浏览器已验证创建 Line、Outline 后得到 4 点 `Line outlined` Vector，Reset 后回到当前固定 24 节点夹具且 console `0` error。2026-08-16 的同一运行时夹具还复验了 Canvas、SVG、PNG 与 PDF：两段 Group 内 alpha Mask 仅裁剪各自 target，粉色/青色矩形在四个输出均为对应椭圆，后续 Polygon、Star、Live Boolean 和 Vector 均保留可见；PDF 使用带 `/SMask` 的 RGBA raster fallback 并保留结构化 sidecar。Line 的实线、虚线和装饰性端帽，以及 Vector 的同标准端帽实线/虚线，均已覆盖；其余非 Vector Outline、复杂混合操作数、跨导出格式 Fixture 的独立验收仍未完成。

补充（2026-08-16）：Document Service Snapshot 回归现固定 live Boolean wrapper、Union 枚举与两个 operand 的父子关系/Canonical Hash 往返，避免服务重启后仅恢复原始 operands。

补充（2026-08-10）：Line 的实线 Outline Stroke 现接受任意标准端帽与装饰端帽组合。Rust 将主线与箭头、三角、菱形、圆点的派生网格统一 union 为闭合填充轮廓，WASM `line_outline_json` 和编辑器的 create/delete/reposition 替换事务消费同一结果。真实浏览器已验证 Arrow + Diamond 的 Line 转为包含 3 个闭合 subpath、11 个锚点的 `Line outlined` Vector，控制台 `0 error`；虚线仅支持相同的 None、Round 或 Square 端帽，装饰端帽与异端帽组合会明确拒绝。

补充（2026-08-10）：Line 的虚线描边现支持 Outline Stroke。当两端均为相同的 None、Round 或 Square 时，Core 的 bounded dash mesh 会为每段可见 dash 生成闭合 Fill 轮廓；WASM `dashed_line_outline_json` 与编辑器替换事务使用同一结果。虚线的异端帽或装饰端帽继续明确禁用，避免把端点样式错误施加给每一段 dash。

补充（2026-08-10）：VectorPath 的同端帽虚线也已接入 Outline Stroke。曲线先由 Rust 确定性 flatten，每个子路径在其起点重启 dash 相位，再将可见 dash 网格 union 为闭合可编辑轮廓；含控制柄的 WASM 黑盒回归已覆盖。异端帽、装饰端帽的虚线 VectorPath 继续禁用。

### G4：Mask、Clip 与命中一致性

**目标**：建立通用 Mask、Frame Clip、嵌套 Clip 和选择规则的一致模型。

**实施内容**：

- 定义 Mask 结构关系、Mask 类型和解除 Mask 的恢复语义；
- 两层以上嵌套 Mask/Clip；
- alpha/luminance 如不能同时交付，先冻结 Phase 2 支持的唯一模式并在兼容矩阵声明；
- Render、Hit Test、Marquee、Selection Bounds、SVG/PDF 共享相同裁剪栈；
- 限制嵌套深度和离屏表面尺寸。

**通过标准**：

- 透明 Mask、旋转 Mask、Mask + Frame Clip 和图片 Mask 的画布、命中与导出一致；
- 解除 Mask 后原节点 ID、顺序、属性和世界变换完整恢复；
- 不可见/被裁掉内容不会被普通点击命中。

**当前候选进度（2026-08-10，2026-08-16 更新）**：ADR 0029 已冻结 Phase 2 的唯一通用模式为同级后续层的 `alpha mask`：可绘制节点的 `SetMask` 标记进入 Canonical Hash、Undo/Redo、WASM batch、Protobuf Operation 与 Service reducer，并通过保留扩展键在 Snapshot 中无损保存。创建与 fixture/import 水合会在同一 Core Transaction 的结构创建、删除和排序完成后发出该专用 `SetMask`，而不是假定投影的 `isMask` 字段会被创建命令消费或过早标记尚未有 target 的 source；因此初始 Snapshot、重载、Undo/Redo 与服务重放都保留掩码语义。Canvas 对含 Mask 的页回退到结构渲染，以隔离 surface 的 `destination-in` 应用 source alpha；最多两层嵌套，每个临时 surface 为 128 MiB 上限，超限时目标 run 失败关闭并记录诊断。遮罩表面现按活跃嵌套深度复用，画布尺寸变化时才重新分配，避免每帧/每个 sibling run 创建全尺寸离屏画布。点击沿 parent 链同时检查 Frame Clip 与最近的前置 Mask，SVG 以同一 sibling run 输出 `mask-type="alpha"`。框选与画布选择叠加层现在都会排除完全落在祖先 Frame Clip 外、或完全不与生效 alpha-mask run 相交的图层；部分重叠保守保留完整选择边界，避免误排除仍可见的像素。图层面板中的实际选中状态不受影响，因此完全裁掉的层仍可从属性面板恢复。Inspector 可启用/解除标记，解除不会改写任何 ID、顺序或变换。真实浏览器重载专业综合 fixture 后已验证 `Alpha mask` 仍选中，且仅导出 `Masked texture target` 的 SVG 含 `mask-type="alpha"`；控制台为 `0 error`。Document Service Snapshot 回归还固定了 `makefigma.mask.alpha.v1` 及外部 `figma.mask.type` 扩展字节的 hash 完整往返，确保服务不会把来源 mask 类型误写为 alpha。PDF、像素 Golden、Selection Bounds 的像素级精确裁剪和独立浏览器恢复验收仍未完成。

补充（2026-08-16）：该批次顺序同时覆盖复制粘贴和 Boolean Flatten、Line Outline、Parametric→Vector 的新 Vector 替换；替换后的 Vector 保留原图层 mask 身份，全部结构命令完成后才发出 `SetMask`。服务端远程 operation 回归已证明这不是仅在本地 WASM 水合下成立的行为。

补充（2026-08-10）：选择裁剪门现在连续相交所有祖先 Frame Clip 与有效 alpha-mask 边界；即使目标分别与各单层重叠、但不存在共同可见区域，也会从普通点击、框选和画布选择叠加层排除。旋转、曲线与 alpha 像素仍保守按世界 AABB 判定，避免误排除可见像素。

### G5：Slice 导出区域

**目标**：补齐架构 §7.2 明确列出的 `Slice` NodeKind，并把它接入节点/区域导出。

**前置决策**：冻结 Slice 是否允许 children、嵌套后的世界坐标、旋转语义、隐藏/锁定行为，以及它对 PNG/SVG/PDF 导出范围的影响。

**实施内容**：

- 非绘制型 Canonical 节点、Operation、Snapshot、Hash、Service 与 WASM；
- 画布选择框、移动/Resize、Layers、重命名、Inspector 与 Undo/Redo；
- Slice 不输出普通 Paint，只提供冻结 revision 的导出区域；
- 单个/多个 Slice 的 PNG/SVG/PDF 导出、资源预算与兼容性报告；
- 越界、旋转、嵌套、透明背景和批量导出 Fixture。

**通过标准**：Slice 在编辑器中可稳定选择和编辑但不污染画布内容；三种导出都严格对应同一世界区域和 revision；保存与服务重放后范围不漂移。

**当前候选进度（2026-08-10）**：ADR 0030 已冻结。`Slice` 已作为无 children、无 Paint/Mask 的 Canonical NodeKind 贯通 Core Hash/Undo/Redo、Protobuf、Snapshot、Document Service、WASM、Worker、Layers 与 Inspector；创建后可通过 Layers 选择、移动、Resize 和重命名。它不会被普通 Canvas Paint 或 SVG 画为内容，且其导出矩形不会截获底下可见图层的画布点击，避免大范围 Slice 使区域内对象无法直接选择或拖动；该选择优先级已提炼为独立单测，覆盖 Slice 覆盖普通图层和单独 Slice 两种情况。选中一个或多个 Slice 的 SVG、透明 PNG 与 PDF 1.4 RGBA/alpha-soft-mask 都以冻结 world matrix 计算输出区域，并以同一旋转四边形裁剪页面内容；PNG 逐张导出，PDF 合为多页。工具栏可选择 1×、2×、4×、8× 倍率，并可将 PNG/PDF 背景设为透明或使用明确的白底/任意 matte；PNG/PDF 在浏览器创建 Canvas 前统一限制为 16,384px 单边、64MP/256MiB RGBA 和 8× 倍率，批量最多 32 Slice 且累计也受同一预算约束。原生可编辑 vector PDF、跨格式兼容报告的独立 Golden 和服务恢复仍留在 G5/X1 后续切片。

## 7. Effect 工作包

### E1：Blend Mode、Shadow、Blur 与离屏纹理池

补充（2026-08-10）：`?fixture=phase2-gpu-layer-blur` 是独立的两个根矩形场景，专门覆盖 WebGPU 单项 Layer Blur 的 source → blur → composite 路径。真实浏览器复验显示 WebGPU scene active、GPU effects 纹理占用为非零（3.6 MiB）且 console 为 `0 error`；两项以上的混合 Effect Stack 仍明确退回 Canvas。

**目标**：完成 Phase 2.10 的常用效果组合。

**当前候选进度（2026-08-10，2026-08-16 更新）**：ADR 0031 已冻结完整 Stack 的顺序、迁移和预算边界。R3 单一 Drop Shadow 已在 Canvas、Snapshot/服务/WASM 和 SVG filter 中可见；SVG 的 blur 采用 `stdDeviation = blurRadius / 2` 的 Canvas 近似。E1 已追加 Protobuf `Effect`、Core 最多 8 项的有序 `effect_stack`、Canonical Hash/Undo、Codec/Service/WASM/Worker 透传；旧 `drop_shadow` 保持为首项兼容投影，旧 Snapshot 继续以空 Stack 读取。Canvas 对多阴影、Layer/Background Blur 与 Inner Shadow 复用三张有界 RGBA8 隔离表面（源图、阴影、scratch；单张 128 MiB、每帧 256 MiB），按 Stack 顺序组合；Drop/Inner Shadow 的非零 spread 在 Blur 前以可分离、透明边界的 alpha morphology（max/min）处理。SVG 的单项 Shadow/Inner Shadow 等价使用 `feMorphology → feGaussianBlur → feOffset`，PNG/PDF 消费同一冻结 SVG，不再把 spread 写为兼容性降级。Live Boolean Wrapper 的同一支持型 filter 现在也会附着于其 Rust 派生路径，而非只保留 Boolean operand 的 paint；因此下游 PNG/PDF 不会漏掉该 wrapper 的单项 Effect。Inner Shadow 以 source alpha 裁剪，Background Blur 捕获当前已合成 backdrop 后以 source alpha 裁剪。Blend Mode 的首批六种模式已作为独立 Canonical Node/Appearance 字段穿过 Snapshot、Operation 与 WASM；Canvas 在最终节点合成时使用等值 `globalCompositeOperation`，含 Blend/Effect 的节点退回 Canvas 以免被当前 WebGPU 普通 alpha pass 错画，SVG 对这六种模式输出 `mix-blend-mode`。WASM 快照回投 UI 图层时现也显式保留 `blendMode`，避免提交后 Inspector 被错误重置为 `Normal`；单元测试与真实浏览器均验证初始 `Overlay`、改为 `Multiply` 后持续回显，控制台为 0 error。Inspector 已支持 Blend 下拉选择、最多 8 个 Drop Shadow 的添加、编辑、显隐、删除；新增完整 Effect Stack 顺序面板可让 Drop Shadow、Layer Blur、Inner Shadow、Background Blur 跨类型重排，并在每次操作中同步 legacy `dropShadow` 首项投影。WebGPU 已具备独立、有预算的 RGBA8 离屏纹理池：单表面 128 MiB、总计 256 MiB，帧内资源固定并在后续帧按 LRU 回收，Device/Renderer 销毁时全部释放；其真实效果路径支持无 spread 的 1–8 项普通 Drop Shadow（每项依序执行 source → 5×5 binomial blur → premultiplied composite，随后只绘制一次本体）、单项 Layer Blur（source → blur → composite，替代本体而非额外叠画），以及单项、zero-spread Inner Shadow（原图 → 含反向 offset 的 blur → 原图 alpha clip + tinted source-over composite）。Inner Shadow 同样仅占两张纹理，颜色以 Canvas 一致的 sRGB 投影量化；纹理预算不足、含 spread 或出现更复杂 Stack 时整个图层安全回退 Canvas。`?fixture=phase2-gpu-drop-shadow` 提供两个无 parent 的固定矩形与两层有序阴影，真实浏览器已复验可见的双阴影、42.8/256 MiB 纹理占用读数与 Reset 后 console `0 error`；`?fixture=phase2-gpu-layer-blur` 切换为单项零 spread Inner Shadow 后也仍为 WebGPU scene active、3.6/256 MiB GPU effects、console `0 error`。`?fixture=phase1-render-composite&simulateGpuLoss=1` 进一步在真实浏览器得到 `WebGPU scene recovered (1) · device-loss simulation 1/1`；同一页面的 `simulateGpuLoss=2` 按预期停在 `Canvas 2D · WebGPU recovery exhausted · device-loss simulation 2/2`，而非无界重试。资源栏会将场景与 Effect 纹理占用分别展示。其余 Effect GPU pass 与 Golden 仍未实现，E1 继续为 Partial。

**Canonical 模型**：

- 有序 Effect Stack；
- Drop Shadow、Inner Shadow、Layer Blur、Background Blur；
- Blend Mode 枚举、效果可见性与透明度；
- R3 的基础 Shadow 无损迁移到 Effect Stack。

**渲染架构**：

1. Rust Render Graph 输出需要的离屏 pass、依赖、裁剪和合成顺序；
2. 浏览器 WebGPU executor 管理有预算的纹理池；
3. Canvas fallback 保持相同效果顺序，无法等价时进入兼容报告；
4. Device Lost 清空派生纹理并从最新不可变投影重建；
5. Effect 绝不写入缓存句柄或设备状态到 Document。

**资源限制**：

- 最大 effect 数、blur radius、离屏尺寸、纹理字节和嵌套深度；
- 预算不足时稳定回退或拒绝，不驱逐当前帧仍引用的资源；
- 连续编辑不得出现纹理数量或 GPU 内存单调增长。

**通过标准**：

- 固定色块、图片、文本、Mask 与多效果顺序通过 Golden；
- Blend、Opacity、Clip 和 Effect 顺序与定义一致；
- 60 分钟连续修改无纹理泄漏；
- 一次 Device Lost 可重建，第二次按现有策略稳定降级。

## 8. 文本与布局工作包

### L1：高级文本编辑闭环

**目标**：让 Phase 1 文本内核可以支撑真实 UI 文本编辑任务。

**实施内容**：

- 选区级 Style Run 编辑：字体、字号、字重、斜体、字距、颜色和 Variable Font axes；
- 粘贴纯文本和版本化富文本，外部 HTML 必须清洗；
- 段落对齐、行高、段落间距与 Auto Width/Height/Fixed Size 的完整交互；
- Text selection Mixed Inspector；
- 复制/剪切/粘贴保持合法 UTF-8 scalar、grapheme 和 run 边界；
- 复杂脚本、RTL/BiDi、Emoji ZWJ、组合字符、IME 和多段落回归；
- SVG/PDF 与离线渲染使用相同 Style Run、行范围和字体 fallback 语义。

**通过标准**：

- 选区样式不会污染相邻字符；
- 文本变化不会导致无关行或光标跳跃；
- Auto Size 的尺寸写入与文本事务保持原子；
- 保存、刷新和 Undo/Redo 后 caret 不持久化，但文本与 Style Run 完整恢复；
- 字体缺失时有可见降级，不改变 Canonical FontId。

**当前候选进度（2026-08-10）**：Inspector textarea 已将 DOM UTF-16 选区转换为 Canonical UTF-8 byte range，并以 `patchTextStyleRuns` 对所选范围原子更新字体、字号、字重、斜体、字距、颜色和轴；新增可访问选区状态会明确提示 mixed styles 与“修改会覆盖选区样式”。`makefigma-text-clipboard-v1` 会重基准选区 Style Runs，复制时同时提供 `text/plain` 与私有 MIME，粘贴优先恢复经验证的私有样式载体；不可信 `text/html` 只读取纯文本。画布 contentEditable 现已接入同一 Copy/Cut/Paste 协议，并以状态重绘避免与浏览器原生 DOM 粘贴叠加；3080 实际页面已验证双击进入、输入、⌘Enter 原子提交和 Undo 恢复。对于显式字体的复杂脚本，Worker 现将 Canonical Style Run 与 Rust 提供的 UAX #9 display-order run 相交，并按物理顺序绘制；RTL 行不再将整行错误地套用第一个 style，颜色、字重和字体范围会保留。未提供形状数据时，纯 RTL 行也会以反向的样式段安全绘制。复杂 IME 与独立屏幕阅读器验收仍待完成，L1 继续为 Partial。

补充（2026-08-16）：导出器会从同一冻结 Snapshot 收集已授权、受 16 MiB 限制的 WOFF/WOFF2/TTF/OTF 字节，并作为隔离的 SVG `@font-face` 嵌入；Style Run 的主字体和 fallback 链在 SVG 中保持引用。Canvas 的绘制和 Auto Size 测量也按同一 Canonical 主字体 → 已加载 fallback chain → 系统字体顺序解析；Canvas fallback 与 SVG tspan 还会以同一规范化顺序消费 `variationAxes`，SVG 输出安全的 `font-variation-settings` 属性。SVG tspan 会逐行输出 Canvas 同源的 paragraph base direction、`unicode-bidi=plaintext` 与 RTL 视觉起始边，避免左对齐 RTL 在导出中反向锚定。无法获得、格式不受支持或超限的字体才进入 `font-asset` sidecar fallback。PNG/PDF 光栅化这份 SVG，因此与 L1 的冻结文本输入使用同一字体来源。

补充（2026-08-10）：Inspector 与画布 contentEditable 的文本输入、IME 提交和不可信 clipboard 文本会将孤立 UTF-16 surrogate 替换为 U+FFFD；画布的原生 input/composition 监听在 React 光标布局前同步规范化瞬态 DOM。提交到 Canonical 的文本与 UTF-8 Style Run 边界因而始终基于合法 Unicode scalar。私有富文本载体若含无效 scalar 则退回纯文本路径，再按当前选区重建样式边界。

补充（2026-08-10）：单一显式字体的 Rust/ICU4X 断行只在该字体覆盖所有已 shape 字形时才驱动画布行范围；任一 glyph ID 为零时，Worker 会稳定退回浏览器 Canvas 的 Unicode grapheme 安全断行，避免 CJK、RTL 或 Emoji 由系统 fallback 字体绘制后仍沿用缺字字体的错误 advance。该 fallback 按 revision 去重，不会在每次重绘重复请求不可用的 Rust layout。

### L2：Constraints 最终收口

**目标**：关闭现有 Constraints 的已知 Partial 边界，为 Auto Layout 提供稳定的普通 Frame Resize 语义。

**实施内容**：

- 将旋转/仿射 Frame 下仍使用 Legacy Geometry 的 child 迁移为 Relative-v1；直接 child 已在 Core 事务内完成，Legacy Group 路径需以完整子树迁移收口；
- 覆盖重入 Resize、镜像、嵌套 Group、Clip、Reparent 和零尺寸 Scale；
- 明确 Constraints 与 Auto Layout 的互斥/覆盖规则；
- Inspector 对不生效的场景必须显示 NotApplicable，而不是保存无效属性。

**通过标准**：

- 所有 Frame child 在支持范围内遵循相同公式；
- 连续放大缩小无累积漂移；
- 重放、Undo/Redo 和服务恢复 Hash 一致；
- Auto Layout child 不会同时被普通 Constraints 二次布局。

**当前候选进度（2026-08-08）**：旋转或仿射 Frame 调整大小时，Core 会把直接 Legacy constrained child 以及其下通过 Group 链连接的完整 Legacy 子树，按父到子的顺序迁移到 Relative-v1。每个 constrained leaf 都先转换到 Frame 本地坐标后计算约束，再转换回其立即父 Group 的本地矩阵；未约束兄弟节点只保留世界姿态。新增 Core 回归覆盖旋转 Frame、一层与两层 Legacy Group、Max/Max 约束、Undo/Redo Hash 恢复和 200→300→200→300 的连续 Resize 无漂移；嵌套 Frame/Section/Boolean 作为独立上下文不被外层 Group 迁移穿透。跨父级移动后，保留的约束在没有有效 Frame/Group 作用域时会由单选和多选 Inspector 明确显示 NotApplicable，而非默默显示为可编辑。活跃 Auto Layout Frame 现在独占最近 Frame 作用域的子层几何：既有 Constraints 会随 Snapshot/Undo/Redo 保留，但不会在 Frame Resize 时与布局引擎重复计算，Inspector 也会明确显示其不适用。

### L3：Auto Layout

**目标**：支持方向、Padding、Gap、Alignment、Hug、Fill、Wrap、Min/Max 和 Absolute 的嵌套布局。

**Canonical 模型**：

- Frame LayoutMode：None/Horizontal/Vertical；
- padding 四边、item spacing、wrap、主轴/交叉轴 alignment；
- child sizing：Fixed/Hug/Fill、min/max、Absolute；
- 文本 Auto Size 与 Hug 的确定性关系；
- 明确布局循环和不可满足约束的错误类型。

**布局引擎要求**：

1. Rust Core 拥有最终布局语义和结果；
2. 修改局部节点只标记受影响祖先链与子树，不允许默认整页重算；
3. 计算分为测量、分配、定位三个稳定阶段；
4. 使用确定性浮点归一化，禁止反复 Resize 产生累积漂移；
5. 单次布局有节点数、递归深度和迭代次数上限。

**实施切片**：

1. 单轴、无 Wrap、固定尺寸；
2. Padding/Gap/Alignment；
3. Hug/Fill 和文本测量；
4. Min/Max 与 Absolute；
5. Wrap；
6. 三层嵌套与增量 Dirty Set；
7. Inspector、拖拽插入、重排和画布反馈。

**通过标准**：

- Button、Input、Card、List、Form 与三层嵌套 Fixture 全部通过；
- 布局无循环、无整页重算、无持续漂移；
- 修改文本只重算必要布局子树；
- Undo/Redo、保存恢复、远端重放和导出结果一致。

**当前候选进度（2026-08-10，2026-08-16 更新）**：ADR 0032 已冻结；Auto Layout 已作为显式 Canonical 记录贯通 Core Hash/Undo/Redo、Protobuf、Snapshot v21、Document Codec、Service reducer、WASM 投影、Worker 与 Inspector。Core 以局部祖先 Dirty Set、确定性浮点归一化、节点与迭代上限处理单轴固定布局、Padding/Gap/Alignment、Frame/文本 Hug、Fill、Min/Max、Absolute、固定尺寸 Wrap 和三层嵌套；文本 Hug 使用确定性度量，CRLF 按单个段落边界处理，避免 Windows 文本在保存恢复后额外增高。`Height` Auto Size 文本还会在其固定宽度上确定性软换行，令 Auto Layout 行高不再取决于浏览器 FontFace；测量以 Unicode grapheme 边界推进，Emoji ZWJ 与组合字符不会被拆为额外布局行。ChildLayout 的 optional `alignSelf`（inherit/start/center/end）会覆盖 Frame 的交叉轴对齐，缺省字段不改变旧 Snapshot Hash，Counter-axis Fill 继续表达 Stretch；协议编码器会为带 child-layout 的非 Frame 节点输出 `setAutoLayout`，真实浏览器对齐已完成服务保存与重载 hash 一致验证。`BASELINE` 已追加到 Protobuf（值 5）并经 Codec、Service、WASM、Inspector 进入 Core：只允许水平 Frame 的交叉轴，Text 按 Canvas 无字形度量 fallback 的 CSS line-box 规则计算第一行基线，非 Text 取下边缘；wrap 逐 track 独立对齐，primary axis、纵向 Frame 与 child override 一律拒绝。Wrap 的 `trackSpacing` 现以 optional Protobuf field 保存：主轴 `itemSpacing` 与交叉轴行/列 gap 可独立配置，旧 Snapshot 缺省时仍保持以 `itemSpacing` 间隔 tracks 的历史几何与 Hash。`trackAlignment: spaceBetween` 同步实现 Figma `counterAxisAlignContent` 的剩余空间分布；只在 Wrap 有效，`auto` 保持显式/历史 track gap。图层 Reparent、删除和 PositionId 重排会同时标记旧/新父容器，避免留下布局空隙。Inspector 仅在有效组合中开放 Wrap、Text Hug、Child Fill、独立 Wrap gap、Wrap track distribution 与水平 Frame Baseline，且在 Auto Layout 作用域内明确覆盖旧 Constraints。自动布局子层在其所属容器内拖动时，画布现会根据同一套 PositionId 重排结果显示旋转/仿射安全的插入线和“插入到第几项”的反馈；拖进其他容器时继续使用已有的 Frame 放置反馈。待关闭项为复杂脚本/RTL 的受限宽度文本、PNG/PDF/SVG 一致导出与独立验收。

补充（2026-08-10）：无历史的 fixture／旧投影 `seed_batch_json` 在完整树与布局记录装载后，会执行一次不增加 revision 的确定性 Auto Layout 回流；已持久化的 Canonical Snapshot 不重算，以继续逐字节校验其既有 Hash。桥接层会先将活跃布局 Frame 与 flow child 的 Relative-v1 矩阵物化为世界坐标，再移除矩阵交给 Core，避免嵌套布局把局部 `x/y` 错当作页面坐标而在重载或导出中偏移。专业综合夹具的三层 Frame 因而按 Padding/Gap 分开，浏览器复验无重叠且控制台为 `0 error`。

## 9. 导出与交付工作包

### X1：PNG、SVG、PDF 与兼容性报告

补充（2026-08-16）：普通 Vector 的 Rust 展平路径也已随同一冻结导出输入进入 SVG/PNG/PDF。新增跨格式回归将 Rust-derived Live Boolean、同级 alpha Mask、世界区域 Slice 与 PDF rasterization sidecar 放进同一 SVG 源，防止 Boolean 被原始 operands 替代、Mask 被普通绘制或 Slice 在 PDF 源中丢失。PDF 仍明确是 raster fallback；原生可编辑 PDF vector 仍是 X1 待办。

补充（2026-08-16）：PDF 光栅输出现改为 PDF 1.4 的 lossless RGB image XObject 加灰度 `/SMask`；选择 Transparent 时，导出保留 alpha，不再强制 JPEG 白底。用户仍可选择任意不透明 matte。PDF sidecar 保留 `pdf-rasterization`，但会准确说明其是“带 alpha soft mask 的光栅”而非可编辑 vector。每个 SVG 根节点及全部 PNG/PDF sidecar 都记录冻结 `sourceRevision`，以及 page/node/slice target、请求格式、sRGB/P3 fallback 与透明/matte 策略，使异步导出可追溯到启动时的 Canonical Snapshot；多页 PDF 的单一 sidecar 会逐页列出同一字段。原生可编辑矢量 PDF 仍是明确未完成项。

补充（2026-08-10）：SVG 现直接导出仅含一项可见 Layer Blur 的节点为有界 `feGaussianBlur` filter（`stdDeviation = radius / 2`），不再把这条标准矢量路径误记为降级；含阴影、Inner Shadow 或 Background Blur 的混合 Stack 因涉及中间合成/背景采样，继续输出结构化兼容性报告。

补充（2026-08-16）：仅含一项的 Inner Shadow 现会输出 `SourceAlpha → morphology(spread) → blur → offset → SourceAlpha clip → color merge` SVG filter，保留内侧裁剪、颜色、透明度以及正/负 spread；任何混合 Stack 仍会输出兼容性降级。

**目标**：让 Phase 2 文档可以稳定交付给下游。

**统一导出输入**：

- 导出器消费冻结 revision 的不可变 Canonical Snapshot；
- 使用与画布相同的几何、裁剪、Mask、Effect、文本和颜色语义；
- 导出期间 Document 可继续编辑，但结果必须对应开始导出时的 revision。

**PNG**：

- 支持透明背景、倍率、Slice/区域/节点导出和资源预算；
- P3 如无法全链路交付，必须显式转换并写入报告；
- 超大表面使用分块渲染或明确拒绝。

**SVG**：

- 补齐 Vector、Boolean、Mask、Effect fallback、图片嵌入和字体策略；
- 所有无法向量表达的 Effect 必须光栅化或进入报告；
- 不可信 SVG/资源不得原样注入导出。

**PDF**：

- 明确页面尺寸、透明度、字体嵌入/轮廓化、图片压缩和颜色策略；
- 多 Page 导出顺序由 Canonical Page PositionId 决定；
- 不支持效果采用确定性光栅 fallback。

**兼容性报告**：

- 列出节点 ID、能力、处理结果和降级原因；
- Supported 项不得出现在警告中；
- Partial/Unsupported 不得静默丢失。

**当前候选进度（2026-08-16）**：SVG 的 Layer Blur、Inner Shadow、Background Blur、未提供冻结几何的 Live Boolean、未授权/缺失/超限的文档字体，以及无效 Slice/节点选择会同时输出人可读 warning 和结构化 `compatibilityFallbacks`（节点 ID、能力、`fallback` 结果、原因）。浏览器导出会先以与画布相同的 Rust/WASM clipping bridge 从当前不可变 Snapshot 派生 Live Boolean 和 Vector 路径，再传入 SVG/PNG/PDF 共用输入；所以有效的 Live Boolean 不需要 Flatten，也不会被误报为 fallback。纯 `exportPageToSvg` 调用若未收到这份冻结派生路径则保守拒绝该 wrapper 及其 operands，并记录 `live-boolean` 降级，绝不输出错误的原始重叠轮廓。已授权且已取得字节、并且不超过 16 MiB 的位图及字体资源分别以 `data:image/...` 和隔离的 SVG `@font-face` 内嵌；无字节、非支持格式或超预算资源会显式记录 fallback，绝不静默替换。每次 SVG/PNG/PDF 导出均下载同名 `.compatibility.json`，即使无 fallback 也记录同一冻结 SVG 输入的 `sourceRevision`、page/node/slice target、请求格式、色彩 profile 和透明/matte 策略。页面、选中节点根及其子树、以及 Slice 都可选择 1×、2×、4×、8× 倍率和透明/不透明背景；节点导出与同一冻结 SVG 输入共享 PNG/PDF 光栅化及兼容报告路径。 “Export all Pages PDF” 按 Canonical `Page.positionId` 顺序合为一个 PDF，并产生单一、逐页列出 ID/名称/revision/目标/格式/透明度/降级项的 `.compatibility.json`。PDF 使用 PDF 1.4 lossless RGBA image XObject 和透明 alpha `/SMask`（或显式 matte），仍无条件记录 `pdf-rasterization`，避免被误认为可编辑矢量。Frame Clip 的 SVG 定义预转换为世界坐标路径，避免浏览器 SVG→Canvas 光栅化时把嵌套内容裁为空白。更多效果与原生可编辑 PDF 仍在结构化 fallback 范围内，X1 继续为 Partial。

**通过标准**：

- 固定 Fixture 的 PNG/SVG/PDF 尺寸、透明度、颜色和视觉对照通过；
- 包含 P3 图片、自定义字体、Polygon、Star、Vector、BooleanOperation、Slice、Mask、Effect 和 Auto Layout；
- 危险资源不进入输出；
- 导出结果与指定 revision 可追踪。

补充（2026-08-10，2026-08-16 更新）：PDF 的 RGBA 光栅降级仍会写入兼容性报告；Transparent 使用 PDF 1.4 alpha soft mask，或可选择任意不透明的 `#RRGGBB` matte。选区、Slice 和按 Canonical Page 顺序合并的多页 PDF 使用同一个背景设置，报告会记录实际使用的透明或 matte 语义。

补充（2026-08-10）：含 Display P3 的 Fill、Stroke、渐变 Stop、文本 Style Run 或阴影颜色会在 SVG 的固定 sRGB 投影中确定性转换；SVG、PNG 与 PDF 共用该冻结 SVG 输入，兼容性报告会以节点为单位记录 `display-p3` 色域收缩，避免静默丢失导出色彩语义。

## 10. 性能与最终验收

### Q1：复杂 Fixture 与专业编辑综合验收

**复杂 Fixture 必须包含**：

- 3 层以上 Auto Layout；
- 多段落、多语言、RTL、Emoji 与混合 Style Run；
- Vector、Boolean 和 Outline Stroke；
- 两层 Mask/Clip；
- 图片、Blend Mode、Shadow 和 Blur；
- 自定义字体与缺失字体 fallback；
- 至少一个 PNG/SVG/PDF 导出目标。

**当前候选进度（2026-08-10，2026-08-16 更新）**：`?fixture=phase2-professional-composite` 已提供固定 `F-PHASE2-PROFESSIONAL-COMPOSITE` 候选输入，含三层嵌套 Auto Layout、多语言/RTL/Emoji 与 Style Run、Frame Clip + 两段独立 Group 内 alpha Mask run、一个仅含 Layer Blur + Drop Shadow 的有序效果栈、复杂 Effect Stack/Blend、缺失图片、内嵌 Inter 字体子集及其未覆盖字形的系统 fallback、Polygon/Star/Vector/Boolean、Outline 结果 Vector 及 Slice。Fixture 测试现逐项冻结这些 Q1 输入的层级、两段遮罩、Effect、资源 fallback、Boolean operand 和导出 Slice，并通过同一 Canonical 原子创建路径；同时冻结 SVG 对两段 Mask/Blend 的输出，以及复杂 Layer Blur、Inner Shadow、Background Blur、字体、Live Boolean 的可见降级，同时验证纯 Layer Blur + Drop Shadow 栈走 SVG filter 组合路径，验证有字节的 PNG 以内嵌 data URI 导出、缺失图片输出结构化 fallback，并确认 PDF 增加带 alpha `/SMask` 的 RGBA rasterization fallback，而非旧的 JPEG 白底路径。夹具的资源索引会在旧投影节点导入前预注册：一个可显示的 PNG、一个缺失图片 fallback 和一个真实字体资源；浏览器复验显示 24 个节点、3 个资源均进入 `Rust/WASM bridge ready`，且主线程的 FontFace 状态为 `loaded`，而非 TypeScript 回退。该 URL 的 Reset demo 在 Flatten 等试验后会重新 hydrate 固定 fixture，恢复 24 节点、3 资源、r0 和相同 Canonical Hash，避免证据运行漂移到通用演示文档。新增 `pnpm evidence:phase2-professional-composite` 会采集该夹具的截图、环境、console 和三轮输入证据，并将 Golden 固定为 `pending-independent-review`；`pnpm evidence:phase2-professional-composite-stability` 会在同一夹具循环执行 Pan、Zoom、Select、Move、Resize、Rotate、Text、Layout、Effect、Undo/Redo，在每轮结束时 Reset demo 并保存独立动作、性能和浏览器堆内存曲线归档、起止截图与 console。它还会从工具栏焦点发送真实 `ArrowRight`/`ArrowLeft` 并验证 Canonical Hash 发生变化，避免合成 Canvas 键盘事件把移动路径误报为通过。默认运行 60 分钟且同样只产出候选：除总时长外，默认还至少需要 30 轮完整采样，任意相邻轮次启动间隔超过 5 分钟即写入失败，避免宿主暂停留下的少量离散记录被误报为连续稳定性。单轮动作、性能或内存探针超过 90 秒会写入失败阶段并终止，避免无界等待。2026-08-16 的最新真实候选采集以 0 秒 warmup、三轮完成：Render P95 中位 3.235ms、Input-to-render P95 4ms、Input backlog P95 0.04ms，三个本地门槛均通过、console 为 0 error；证据目录为 `output/phase2-professional-composite/current-candidate/`。它们仅验证采集链路，不能替代独立的 60 分钟 Gate。完整 Outline 事务、独立 Golden/60 分钟和设计师验收仍待完成，Q1 继续为 Partial。

**自动性能 Gate**：

- 常规拖动、缩放、旋转、文本输入和布局修改的 Input-to-render P95 < 50 ms；
- 无持续 CPU/WASM/GPU 内存增长；
- 局部布局修改不得触发整页重布局；
- 资源预算拒绝必须可诊断且不修改 Document；
- Worker、GPU 和服务恢复后 Document Hash 一致。

**稳定性 Gate**：

- 固定源码和生产构建连续编辑 60 分钟；
- 循环执行 Pan、Zoom、Select、Move、Resize、Rotate、Text、Layout、Effect 和 Undo/Redo；
- console 0 error；
- 起止截图、性能摘要、内存曲线、环境和源码 Hash 全部归档；任一单轮采集超时必须以失败产物终止，不能静默挂起。

**设计师综合验收**：

- 由未参与开发的设计师复刻一张包含嵌套布局、图标、文本、Mask、Effect 和图片的复杂页面；
- 基础流程同时进行一次键盘验收；
- 输出 PNG/SVG/PDF 并与参考视觉人工对照；
- 记录完成时间、阻断问题、降级项和导出差异。

**Phase 2 最终通过标准**：

- Phase 2.1–2.16 全部形成闭环；
- 关键 Golden、几何、文本、布局、效果与导出回归集通过；
- 60 分钟稳定性和设计师验收由独立人员签署；
- 兼容矩阵与实际行为一致；
- 无 P0/P1。

## 11. 每个工作包的完成定义

任何工作包只有同时满足以下条件才能标记完成：

1. Canonical 模型、验证、资源上限和错误码已冻结；
2. Snapshot、Operation、Codec、Service、WASM 与 Worker 完成往返；
3. Hash、Undo/Redo、服务重放和冲突恢复有测试；
4. Canvas/WebGPU fallback、Hit Test、Selection Bounds 和导出行为一致；
5. 单选、Mixed Inspector、键盘和可访问状态完成；
6. 旧 Snapshot 迁移 Fixture 与新版本 Fixture 归档；
7. 兼容矩阵已更新；
8. 自动测试、真实浏览器证据和必要的人工验收归档；
9. 生产构建和完整 CI 通过；
10. 没有以 TODO、静默降级或文档承诺替代实际闭环。

## 12. 建议的里程碑 Gate

### Milestone A：Phase 2A Common Nodes 完成

- R0、R1、R2 完成；
- 当前 Common Nodes P0/P1 清零；
- 形成可提交、可回滚、可由 CI 重现的稳定基线。

### Milestone B：专业图形完成

- R3、G0、G1、G2、G3、G4、G5 完成；
- Polygon/Star/Vector/Pen/BooleanOperation/Slice/Mask 在画布、命中、保存和 SVG 中闭环；
- 无几何算法多源漂移。

### Milestone C：效果、文本和布局完成

- E1、L1、L2、L3 完成；
- 真实 UI 组件可由 Auto Layout、复杂文本和常用 Effect 搭建；
- 复杂场景仍满足资源预算和增量更新要求。

### Milestone D：Phase 2 Beta Gate

- X1、Q1 完成；
- PNG/SVG/PDF 和兼容报告可交付；
- 性能、稳定性、可访问性和设计师验收全部独立签署；
- 无 P0/P1，正式进入 Phase 3。

## 13. 首批可直接创建的任务

1. 整理当前未提交工作区并建立 Phase 2 completion checklist。
2. 定义 `makefigma-node-clipboard-v1` 格式及跨文档资产授权流程。
3. 为 `resolvePasteBatch` 增加 schema、Hash、节点数、深度和总字节校验。
4. 完成真实跨文档/跨标签页剪贴板浏览器测试。
5. 重采并独立签署 Mixed Inspector A11y 与 Common Nodes Golden/性能。
6. 为画布旋转控制柄编写交互和矩阵 Fixture。
7. 为基础 Shadow/Effect Stack 编写 ADR 与 Protobuf 字段提案。
8. 冻结 Polygon/Star 参数模型、BooleanOperation 活结构、Slice 语义和 UnknownNode 降级 ADR。
9. 为 VectorPath 编写 Canonical 数据模型 ADR、资源预算和 Snapshot v20 迁移设计。
10. 建立 Vector 几何退化测试集，先于 Pen Tool UI。
11. 建立覆盖 8 类 Phase 2 新节点的固定 Fixture 与兼容矩阵。
12. 为 Auto Layout 编写 sizing/循环/增量 Dirty Set ADR，禁止 UI 先行。

## 14. 风险清单

| 风险 | 后果 | 控制措施 |
| --- | --- | --- |
| 把 Common Nodes 当作完整 Phase 2 | 提前进入 Phase 3，核心能力长期缺失 | 使用 Milestone A–D 分层命名，最终 Gate 只认 2.1–2.16 |
| 遗漏架构 §7.2 的 Polygon/Star/Slice | 名义完成与 NodeKind 目标不一致 | 使用独立图层类型追踪矩阵，8 类逐项 Gate |
| Boolean 只生成一次性 Vector | 无法满足 BooleanOperation NodeKind 和可恢复结构目标 | ADR 冻结活结构/Flatten；若改目标必须同步改总架构 |
| Vector/Boolean 多套几何实现 | 画布、命中和导出长期漂移 | Rust 几何单一来源，TS 仅消费已验证结果 |
| Auto Layout UI 先于 Core | Hug/Fill 被临时宽高污染，难以迁移 | Canonical/算法/Fixture 先行，UI 最后接入 |
| Effect 无预算离屏 | GPU 内存增长、Device Lost、导出失控 | Render Graph + 纹理池预算 + 稳定 fallback |
| 文本选区使用 UTF-16 直接持久化 | 拆分字素、Emoji、组合字符和 Style Run | 所有持久化范围使用合法 UTF-8 scalar/grapheme 边界 |
| 导出另写视觉逻辑 | 导出与画布不一致 | 共享几何、文本、裁剪和效果语义，冻结 revision 导出 |
| 证据由实现者自签 | Gate 失去独立性 | Golden、A11y、稳定性和设计师验收必须独立签署 |
| 当前工作区未集成 | 本地全绿但 CI/干净环境不可复现 | R0 优先，先形成干净基线再扩范围 |
