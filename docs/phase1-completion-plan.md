# Phase 1 收口实施与验收计划

- 状态：待执行
- 基线提交：`5c459da67a5264687682522416935f2f61aa3109`
- 编制日期：2026-08-05
- 适用范围：Phase 1.1–1.11 余项、阶段 Gate 与进入 Phase 2 的前置条件

## 1. 目的与结论

本文把 Phase 1 当前剩余工作拆成可以直接开发、测试和验收的任务，目标不是扩充 Phase 1，而是完成架构文档第 23.4 节已经定义的 Gate，并形成可审计的阶段完成记录。

当前结论是 **Phase 1 尚未完成，不能正式进入 Phase 2**。Document/Page、Protobuf、单客户端 Operation、资源上传下载、Canonical Text、Rust Render Graph 和专项 Fixture 已具备主要骨架，但仍有以下阶段级缺口：

1. GitHub `main` 验证流程当前无法启动 pnpm，远端 Gate 为红色；
2. 资源管线仍缺完整隔离解码、EXIF/ICC 处理、可替换对象存储边界和服务端审计闭环；
3. 文本仍有 Canvas/DOM 过渡路径，复杂文本、Variable Font、FreeType、Caret/Selection/IME 的统一内核闭环未完成；
4. Rust `wgpu` executor 尚未接管浏览器主路径，Image Atlas、复杂文本 GPU 路径和真实 Device Lost 全量重建未完成；
5. Phase 1.11 只有部分自动证据，没有完整的独立人工验收、核心 Golden、B1 性能结论、30 分钟稳定性记录和阶段签字；
6. 仓库中不存在 `verification/phase1/completion.md`，README 仍声明项目处于 Phase 1。

本文完成后的唯一阶段结果应是：Phase 1 Gate 明确记录为 `PASS` 或 `FAIL`。不得使用“基本通过”“先进入 Phase 2 再补”等中间结论。

## 2. 范围边界

### 2.1 本计划包含

- Phase 1.1–1.4 已实现能力的缺口测试与纵向验收；
- Phase 1.5–1.10 尚未闭环的资源、文本和渲染实现；
- Phase 1.11 Fixture、Golden、性能、恢复和人工验收证据；
- CI、兼容矩阵、README 和阶段完成记录；
- 阶段切换前的 P0/P1 缺陷审计。

### 2.2 本计划不包含

以下能力仍属于 Phase 2，不得为了完成 Phase 1 提前混入：

- Section、Group、Line；
- 嵌套图层树 UI、跨父级拖拽排序；
- 八方向缩放和多选 Transform；
- Shadow、Mixed Inspector、完整键盘可访问性；
- Vector、Boolean、Mask、Effect；
- Constraints、Auto Layout；
- PNG/SVG/PDF 正式导出。

多人 Presence、并发合并、评论、协同 Undo 和跨设备恢复继续属于 Phase 4。

## 3. Phase 1 完成定义

只有同时满足以下条件，才能创建 Phase 1 完成记录并开始 Phase 2 主线开发：

- 1.1–1.11 每一步都有唯一验收记录，结果均为 `PASS`；
- `main` 的必需 CI 全绿，生成文件与源码无漂移；
- 多页面、父子顺序、Operation、Asset 和 Text 版本契约冻结；
- 客户端与服务端在提交、离线、重试、冲突和恢复后得到相同 Document Hash；
- 图片和字体的正常、损坏、越权、取消、资源耗尽路径全部有确定结果；
- 中英、RTL、Emoji、Ligature、Variable Font、Caret、Selection 和 IME 基线通过；
- 浏览器正式路径由冻结的 Rust Render Graph 驱动，Device Lost 能全量重建或明确降级；
- 综合 Fixture 连续编辑 30 分钟，无文档损坏、未处理控制台异常或持续内存增长；
- B1 环境常规拖动、缩放和文本输入的 P95 输入到画面延迟 `< 50 ms`；
- 核心 Golden 已由非实现者审核并冻结；
- 不存在未解决的 P0/P1；P2/P3 均记录负责人、期限和不阻塞理由；
- 技术负责人或指定验收人签署 `verification/phase1/completion.md`。

## 4. 当前状态矩阵

状态含义：

- `接近完成`：主要实现已存在，重点是补纵向测试和正式验收；
- `部分完成`：已有基础实现，但需求中的关键路径仍缺失；
- `未过 Gate`：即使局部测试通过，也不能声明该 Step 完成。

| Step | 当前状态 | 已有基础 | 主要缺口 | 收口工作流 |
|---|---|---|---|---|
| 1.1 | 接近完成 | Snapshot v15、Document/Page、parent/position、迁移与多页面投影 | 最近版本迁移矩阵、坏引用、重复 PositionId 和人工 round-trip 记录 | W1 |
| 1.2 | 接近完成 | 单一 Proto、Rust/TS 生成类型、版本协商、Opaque Envelope | 最近三个格式版本 Fixture、真实中转未知字段、CI 生成物漂移检查 | W1 |
| 1.3 | 接近完成 | Rust Document Service、AuthZ、SQLite 事务、幂等 revision | 服务进程中断矩阵、配额/引用/Hash 纵向验证、正式验收记录 | W1 |
| 1.4 | 接近完成 | IndexedDB pending、顺序发送、Ack、重试、冲突对账 | 浏览器真实 HTTP E2E、刷新/断网/服务重启组合、最终 Hash 证据 | W1 |
| 1.5 | 部分完成 | AssetId、探测 Worker、取消、CPU/OPFS 缓存、占位降级 | 完整隔离解码、EXIF、ICC/P3、字体深度校验和压力回收证据 | W2 |
| 1.6 | 部分完成 | 分段上传、Hash/MIME、去重、授权、短期凭据、SQLite 持久化 | 对象存储适配边界、失败重试、孤儿清理、耐久审计投递 | W2 |
| 1.7 | 接近完成 | FontId、Style Runs、段落、Auto Size、Fallback、语义版本 | 最近版本迁移、Variable Font 和缺失字体跨端 round-trip 验收 | W3 |
| 1.8 | 部分完成 | Rustybuzz、ICU4X、Bidi、Caret byte map、基础 glyph raster/atlas | FreeType 决策、复杂 run/RTL/Variable Font、画布 Caret、Selection/IME 一致性 | W3 |
| 1.9 | 部分完成 | Rust Render Graph、固定 Pass、WASM 投影、原生 wgpu executor | 浏览器主路径接管、完整 Pass 输入一致性、Canvas/WebGPU 核心 Golden | W4 |
| 1.10 | 部分完成 | Buffer/Texture/Pipeline、离屏池、单页 Glyph Atlas、预算和一次重建模型 | Image Atlas、多页/淘汰、真实 Device Lost 接线、OOM/Validation Error 全路径 | W4 |
| 1.11 | 未过 Gate | 五类固定 Fixture、部分恢复/编辑/性能脚本 | 完整报告、独立审核、30 分钟、B1 P95、Golden、缺陷表和签字 | W5 |

## 5. 实施顺序与依赖

推荐按以下顺序推进：

1. **Wave A：恢复可信门禁**——完成 W0，并创建 W5 的报告骨架；
2. **Wave B：冻结契约**——完成 W1，确认 Phase 2 不会反向修改 Document/Operation；
3. **Wave C：完成资源与文本**——W2、W3 可并行，但两者必须先统一 Font Asset 输入契约；
4. **Wave D：接管浏览器渲染**——W4 依赖 W2 的稳定图片输入和 W3 的稳定 glyph 输入；
5. **Wave E：综合验收**——执行 W5，关闭缺陷并形成阶段完成记录。

任何 Wave 发现数据损坏、安全绕过或不可恢复问题，应立即标记为 P0 并停止后续阶段工作。

### 5.1 建议责任角色与相对规模

相对规模只用于排期比较，不代表固定工期；实际排期应在技术决策完成后由负责人确认。

| 工作流 | 建议负责人角色 | 评审角色 | 相对规模 | 关键依赖 |
|---|---|---|---:|---|
| W0 CI/门禁 | Build/平台工程 | 各责任域负责人 | S | 无，必须最先完成 |
| W1 Document/Operation | Rust Core + Backend | Web 存储/恢复 | M | W0 |
| W2 Asset | 资源/安全工程 | Backend + Graphics | L | W0；字体输出需与 W3 对齐 |
| W3 Text | 文本/图形工程 | Web 编辑体验 | XL | W0；字体字节来自 W2 |
| W4 Rendering/GPU | 图形工程 | Rust Core + Web Worker | XL | W2 图片输入、W3 glyph 输入 |
| W5 综合验收 | QA/性能工程 | 非实现者、技术负责人 | L | W0–W4 全部完成 |

关键路径为 `W0 → W2/W3 → W4 → W5`。W1 可以在 W2/W3 开发期间并行收口，但必须在 W5 前冻结 Document 和 Operation 契约。

---

## 6. W0：CI 与阶段门禁恢复

### 目标

让远端 `main` 真正执行并强制验证 Phase 1，而不是只依赖开发机上的成功结果。

### P1-CI-01：修复 pnpm 初始化顺序

当前 `.github/workflows/verify.yml` 在 `actions/setup-node` 中启用 `cache: pnpm`，但 pnpm 要到后续 `corepack enable` 才可用，导致 workflow 在安装依赖前失败。

实施：

- 在 `setup-node` 缓存解析前安装固定版本 pnpm；推荐使用官方 pnpm setup action并锁定 `11.8.0`；
- 或取消 `setup-node` 的 pnpm cache，先执行 Corepack，再使用显式缓存步骤；
- 保持 `package.json#packageManager` 为唯一版本来源，禁止 CI 使用浮动 pnpm 版本。

Done：

- 新提交触发的 GitHub `Verify` 成功进入依赖安装阶段；
- `pnpm --version` 输出 `11.8.0`；
- `pnpm install --frozen-lockfile` 通过；
- 缓存命中与否不影响结果。

### P1-CI-02：拆分必需验证 Job

将单一 Job 拆成可独立定位的检查：

1. `web`：lint、Vitest、Next production build、前端边界；
2. `protocol`：Proto 生成、TypeScript 编译、生成后 `git diff --exit-code`；
3. `rust`：`cargo test --workspace`；
4. `services`：Document API、Asset API、Mock Backend；
5. `wasm`：重新生成 WASM 后 `git diff --exit-code`；
6. `renderer-native`：`cargo test -p makefigma-renderer-wgpu --features native-wgpu-executor`；
7. `phase1-fixtures`：五个 `check:phase1-*` 命令。

Done：

- 七类检查均在 GitHub 上通过；
- 任一检查失败时可以从 Job 名称直接定位责任域；
- 分支保护将这些 Job 设为 `main` 的必需检查。

### P1-CI-03：保存可审计产物

实施：

- 上传测试报告、构建日志和 Fixture manifest；
- 浏览器证据任务上传 screenshot、console、performance summary 和 metadata；
- 产物名称包含 commit SHA、运行环境和 Step 编号；
- 设置明确保存周期，阶段完成证据另行提交到 `verification/phase1/`。

Done：从任意 Phase 1 验收报告可以追溯到一次完整 CI 运行及其原始产物。

---

## 7. W1：Document、协议和单客户端 Operation 闭环

本工作流原则上不新增产品能力，重点是把 1.1–1.4 从“单元测试存在”提升为“纵向 Gate 可证明”。

### P1-DOC-01：建立最近三个 Snapshot 版本 Fixture

实施：

- 固定 v13、v14、v15 三个只读输入 Fixture；
- 每个 Fixture 至少包含两个 Page、两层 Frame、兄弟节点顺序、图片引用和文本属性；
- 记录源文件 Hash、迁移后 Canonical Hash 和迁移告警；
- 覆盖 v13→v15、v14→v15、v15 round-trip；
- 增加坏 parent、跨 Page parent、重复 PositionId、缺失资源引用和节点环输入。

建议落点：

- `fixtures/documents/phase1-snapshot-v13.fixture.json`
- `fixtures/documents/phase1-snapshot-v14.fixture.json`
- `fixtures/documents/phase1-snapshot-v15.fixture.json`
- `crates/editor-wasm/src/lib.rs` 迁移测试
- `crates/document-codec/src/lib.rs` Protobuf round-trip 测试

Done：合法输入迁移后结构与 Hash 稳定；非法引用被拒绝或按明确规则修复，并产生可诊断结果。

### P1-DOC-02：补充协议中转和版本兼容测试

实施：

- 使用真实 HTTP 入口发送包含未知字段的 Operation Envelope；
- 中转/队列只保存和转发 opaque bytes，验证未知字段逐字节保留；
- 验证不支持的 protocol/schema/engine semantics 返回结构化错误；
- 增加 Rust 生成类型与 TypeScript 生成类型的共享二进制 Fixture；
- CI 生成后必须确认仓库无 diff。

Done：Rust→TS、TS→Rust 和 opaque relay 三条路径通过；不存在第二套手写 wire type。

### P1-OPS-01：Document Service 故障矩阵

覆盖：

- 重复 operation ID；
- 相同 ID 不同 payload；
- payload hash 篡改；
- tenant、document、actor 越权；
- 过期 base revision；
- 无效引用和超配额写入；
- durable commit 前终止；
- durable commit 后、Ack 前终止；
- SQLite 重开和幂等重放。

Done：只有耐久提交返回 Accepted；`document_id + operation_id` 和 accepted revision 唯一；服务重启后 revision、Snapshot 与 Canonical Hash 一致。

### P1-OPS-02：浏览器真实 HTTP 对账 E2E

实施：

- 同时启动 Web、Document API 和 Asset API；
- 离线编辑后刷新，确认 pending 仍存在；
- 恢复网络，重复发送不会重复修改；
- 服务重启后继续同步；
- 分别注入 Accepted、Conflict、Permanent Reject；
- Conflict 获取远端 Snapshot 后重放仍有效的本地 pending；
- Permanent Reject 停止同步并向用户显示可诊断原因；
- 最终比较浏览器 WASM Core 与服务端 Snapshot 的 revision 和 Canonical Hash。

建议新增 `scripts/capture-phase1-operation-recovery-evidence.sh`。

Done：所有场景无已确认操作丢失、无重复应用、无无限重试，客户端与服务端最终一致。

### W1 验收产物

- `verification/phase1/1.1/<build-id>/acceptance.md`
- `verification/phase1/1.2/<build-id>/acceptance.md`
- `verification/phase1/1.3/<build-id>/acceptance.md`
- `verification/phase1/1.4/<build-id>/acceptance.md`
- Fixture、Hash、日志和恢复前后 Snapshot。

---

## 8. W2：图片、字体与 Asset Service 收口

### P1-ASSET-01：把“头部探测”升级为隔离解码

当前 Asset Probe Worker 能执行有界 MIME/头部检查，但完整图片/字体解析和解码仍不应发生在主线程。

实施：

- 将图片完整解码保持在独立 Worker/隔离上下文；
- 解码前检查文件字节、声明尺寸和预计像素内存；
- 解码后再次检查实际尺寸、alpha、方向和内存；
- 为 JPEG EXIF Orientation 定义统一归一化结果；
- 对嵌入 ICC/P3 的图片生成确定的 Canonical 色彩元数据或明确 sRGB 转换；
- 字体解析验证 table offset、face index、glyph 数、variation axis 和轮廓预算；
- 取消信号必须贯穿读取、探测、解码、上传和注册，迟到结果不得写入 Document。

建议落点：

- `src/workers/asset-probe.worker.ts`
- 新增 `src/workers/asset-decode.worker.ts`
- `src/lib/untrusted-asset.ts`
- `src/lib/asset-probe-budget.ts`
- `fixtures/assets/phase1-asset-hostile.fixture.json`

Done：正常、损坏、伪造 MIME、截断、超大像素、EXIF、ICC/P3、字体炸弹和取消用例均得到确定结果，主线程无长任务，失败不修改 Canonical Document。

### P1-ASSET-02：完成缓存一致性与回收

实施：

- CPU ImageBitmap 缓存按已解码实际内存计费；
- OPFS 原始字节缓存读取时按 content hash 复核；
- 淘汰中的对象不能被新请求复活为错误版本；
- Device Lost 后只从已验证字节重建派生 GPU 资源；
- 验证取消、失败、页面切换、文档关闭后的预算释放；
- 增加缓存损坏、并发命中和超预算测试。

Done：CPU/OPFS 缓存始终在预算内；回收后内存下降；缓存损坏只触发重新下载或占位，不污染 Document。

### P1-ASSET-03：冻结对象存储适配边界

实施前需要做一次明确决策，不能让 SQLite BLOB 既被当作开发适配器又被当作已完成的对象存储：

- 在 `asset-service` 定义 `AssetObjectStore` 接口；
- SQLite 仅保存上传状态、对象元数据、ACL、Document 附加关系和审计索引；
- 至少提供一个可耐久失败注入的本地文件对象存储适配器；
- 若 Phase 1 必须验证远端对象存储，再增加 S3-compatible 测试适配器；
- 如果项目决定 Phase 1 接受 SQLite BLOB，必须通过 ADR 正式修改验收边界并说明迁移方式，不得只改 README。

Done：对象写入成功后才能完成 Asset；对象存储短暂失败可重试；数据库与对象之间不存在不可解释的悬空引用。

### P1-ASSET-04：服务端资源审计与孤儿清理

实施：

- 服务端生成脱敏、结构化、耐久的上传、拒绝、去重、附加、授权、下载和删除审计事件；
- 不记录文件名、原始 URL、字节内容、未可信 actor 或凭据；
- 为未完成 upload、未附加对象和过期 grant 建立可重复执行的清理任务；
- 清理与 attach/complete 使用事务或可证明的补偿顺序；
- 增加跨 tenant、伪造 hash、过期 grant 和清理竞态测试。

Done：越权和损坏对象不可引用；失败重试不创建重复或悬空对象；审计事件能按 document/asset/result 定位且不泄露敏感输入。

### W2 验收产物

- 更新后的 `F-ASSET-HOSTILE`；
- 正常图片、EXIF、P3/ICC、Variable Font 和损坏字体 Fixture；
- `verification/phase1/1.5/<build-id>/acceptance.md`；
- `verification/phase1/1.6/<build-id>/acceptance.md`；
- 缓存预算、取消、越权、对象存储失败和审计日志证据。

---

## 9. W3：Canonical Text 与正式文本引擎收口

### P1-TEXT-01：冻结 FreeType 与栅格化决策

当前 `graphics-core` 使用 Rustybuzz、ICU4X 和 `ttf-parser`，已有受限 outline alpha raster，但 Phase 1 需求明确写有 FreeType。

必须二选一：

1. 集成可在目标 WASM/Worker 环境稳定构建的 FreeType 路径；或
2. 通过正式范围变更评审和 ADR 将正式栅格器改为当前 Rust 实现，同步更新架构文档与兼容矩阵，并以跨平台 Golden、hinting 差异、字体安全和维护成本证明等价性。

Done：只能存在一个被声明为正式的 glyph rasterization 事实来源；Canvas/system raster 仅作为明确降级，不参与 Canonical 布局判定。

### P1-TEXT-02：完成按 Style Run 的塑形与断行

实施：

- 逐 Style Run 解析 FontId、face index、variation axes、字号、字重、斜体和字距；
- 按 script、language、direction 和 font fallback 拆分 shaping runs；
- Bidi visual order 不改写原始 UTF-8；
- 断行只能发生在 ICU4X 合法边界，Caret 不能落入字素簇内部；
- 混合字体和缺失 glyph 使用确定的 fallback chain；
- Variable Font 坐标进入 glyph cache key；
- 客户端与离线/服务端验证工具使用同一 engine semantics version。

Done：混合 Style Run、RTL/LTR 混排、Emoji ZWJ、Indic、Ligature、Variable Font 和缺失字体布局稳定，刷新与服务端重放不漂移。

### P1-TEXT-03：把 Caret Map 接入画布编辑器

实施：

- Caret Map 除 byte offset 外还需提供 line、visual position、advance、height 和 affinity；
- pointer 坐标到 caret、方向键移动、Shift 选区、删除和替换均使用 Rust 结果；
- 浏览器 textarea 只承担输入法接收，不决定文本布局；
- composition start/update/end 不写入 Canonical Document，只有 commit 形成单个原子 Transaction；
- Esc 取消恢复原文和选区；
- Worker 恢复、页面切换和字体迟到加载后恢复合法 selection。

Done：中文输入法、英文、阿拉伯文、Emoji、Ligature 的输入、选择、删除、换行和撤销无丢字、错位或光标跳跃。

### P1-TEXT-04：完成 Glyph Cache/Atlas 生命周期

实施：

- glyph key 包含字体 content hash、face、variation、glyph ID、pixel size 和 raster semantics；
- 支持多页或明确有界淘汰，不能因单页已满让整个文档永久降级；
- 淘汰不能破坏当前帧；
- Device Lost 后从字体字节与 glyph key 重建；
- 超过预算时按节点或 run 明确降级，不产生半 GPU/半 Canvas 的重影；
- 记录命中率、页数、字节数、淘汰和降级原因。

Done：F-TEXT-10K 在预算内完成，连续编辑和页面切换无持续增长，Device Lost 前后布局与 Document Hash 不变。

### P1-TEXT-05：文本验收矩阵

至少包含：

- 中文拼音和候选上屏；
- 英文 Ligature；
- 阿拉伯文和希伯来文；
- LTR/RTL/数字混排；
- Emoji ZWJ、肤色、旗帜和组合字符；
- Indic；
- Variable Font 两个以上 axis；
- 缺失主字体、fallback 命中和完全缺字；
- 混合 Style Run 跨行；
- Auto Width、Auto Height、Fixed Size；
- 10,000 UTF-8 字节压力文档。

Done：自动回归、交互录屏、布局 Hash、核心 Golden、性能和人工签字全部齐全。

### W3 验收产物

- 文本栅格 ADR；
- 更新后的 `F-TEXT-MULTILINGUAL` 与 `F-TEXT-10K`；
- `verification/phase1/1.7/<build-id>/acceptance.md`；
- `verification/phase1/1.8/<build-id>/acceptance.md`；
- 字体 Hash、engine semantics version、布局结果和 Golden。

---

## 10. W4：Rust/wgpu 浏览器主路径与 GPU 恢复

### P1-GPU-01：冻结浏览器执行架构

必须明确 Rust Render Graph 如何成为浏览器主路径：

- Canonical Document 继续只在 Rust Core；
- Rust 导出不可变 Scene/Render Graph/批次，不向 React 暴露逐节点 GPU 调用；
- Engine Worker 独占 GPU Device、Surface 和派生资源；
- TypeScript 只能负责编排、输入传递和明确 fallback，不得维护第二套渲染语义；
- 浏览器与 native executor 共享 Pass 顺序、实例布局、颜色和资源预算契约。

如果浏览器仍由 TypeScript 持有 WebGPU API，应通过 ADR 说明它如何严格执行 Rust 产出的 graph；如果改为 Rust `wgpu` WASM executor，应先验证包体、线程、Surface 和 Device Lost 支持。两条路线只能选一条作为正式路径。

Done：主路径和 fallback 的职责只有一个当前决策，并有端到端测试证明没有双重事实来源。

### P1-GPU-02：完成正式 Pass 输入

实施：

- MainScene：Frame、Rectangle、Ellipse 的 fill/stroke/rotation/corner；
- Image：已验证图片、cover crop、opacity、rotation；
- Text：W3 产出的 glyph draws；
- Overlay：选择框、辅助线等瞬态图元，不写入 Document；
- Composite：固定 alpha、颜色空间和 pass order；
- Gradient 等未进入 GPU 的能力必须作为 graph 中明确的 fallback 节点，不能隐式绕过排序。

Done：相同 revision 的 pass、资源键和 z-order 稳定；缓存失效、拖拽提交和页面切换不显示旧 revision。

### P1-GPU-03：Image Atlas、Glyph Atlas 与离屏池

实施：

- Image Atlas 或等价有界纹理复用策略；
- Glyph Atlas 多页/淘汰策略与 W3 共用 key；
- 离屏纹理按尺寸/格式/用途复用；
- 所有 Buffer、Texture、Pipeline 和 Bind Group 进入统一预算统计；
- 借用资源只能服务当前帧，不能进入 Canonical 状态；
- 资源替换先完成新资源准入，再释放旧资源；失败不得破坏当前可渲染状态。

Done：连续加载、切页、缩放、文本编辑和图片替换无持续 GPU 内存增长；超预算进入可解释降级。

### P1-GPU-04：真实 Device Lost 全量重建

实施：

- 接入浏览器真实 `device.lost`；
- 第一次丢失：停止提交、丢弃全部 GPU 派生缓存、创建新 Device、从最新确认 revision 重建；
- 重建期间 Canonical Document 不变，pending Operation 继续安全保存；
- 重建成功后比较视觉、revision 和 Hash；
- 第二次连续失败：停止重试并稳定进入 Canvas/WebGL 降级；
- OOM、Validation Error 和上传失败分别产生结构化诊断；
- 降级状态仍允许下载 Snapshot。

Done：无无限重试、无资源泄漏、无旧 Device handle 复用；恢复或降级都不损坏文档。

### P1-GPU-05：Canvas/WebGPU Golden

实施：

- 固定浏览器、GPU、DPR、视口和字体；
- 对基础形状、图片、文本、渐变 fallback 和 Overlay 分层采集；
- 再采集组合场景；
- 定义逐像素容差和允许差异区域，不以肉眼描述替代机器规则；
- 候选 Golden 必须由非实现者审核后冻结；
- Golden manifest 记录输入 Hash、commit、schema、engine semantics、浏览器和 GPU。

Done：核心 Golden 在 WebGPU、Canvas/WebGL 降级以及 Device Lost 恢复后均通过。

### W4 验收产物

- 浏览器执行架构 ADR；
- `verification/phase1/1.9/<build-id>/acceptance.md`；
- `verification/phase1/1.10/<build-id>/acceptance.md`；
- GPU 资源统计、故障注入日志、恢复前后截图和 Golden manifest。

---

## 11. W5：Phase 1.11 综合验收与阶段切换

### P1-QA-01：建立统一验收目录

每次候选构建使用：

```text
verification/phase1/1.11/<build-id>/
  acceptance.md
  environment.json
  fixture-manifest.json
  defects.md
  console/
  screenshots/
  recordings/
  performance/
  recovery/
  hashes/
```

`build-id` 必须绑定 Git commit，不允许用“latest”覆盖历史结果。

### P1-QA-02：固定验收环境

至少执行：

- B1：Windows 11、16 GB、集成显卡、Chrome/Edge Stable、DPR 1；
- B2：Apple M1 8 GB 或同级、Chrome Stable、DPR 2；
- B3：macOS Safari Stable；
- B4：禁用 WebGPU 或 WebGPU 不可用的降级环境。

每个环境记录 OS、浏览器、GPU、DPR、分辨率、字体、网络状态和 Feature Flag。

### P1-QA-03：执行纵向 Fixture 矩阵

| 场景 | 必须验证 |
|---|---|
| 多页面 | 创建、切换、嵌套 Frame、保存、刷新、迁移、顺序 |
| Operation | 离线、刷新、重发、冲突、拒绝、服务重启、最终 Hash |
| F-TEXT-MULTILINGUAL | 中英、RTL、Indic、Emoji、混合 run、Caret/IME |
| F-TEXT-10K | 加载、输入、选择、换行、预算、恢复 |
| F-ASSET-HOSTILE | MIME、脚本、损坏、超限、取消、越权、审计 |
| F-SHAPE-100K | 加载、裁剪、缩放、拖动、内存、恢复 |
| F-PHASE1-RENDER-COMPOSITE | 图片、形状、渐变、文本、排序、Golden |
| 故障恢复 | Worker crash、Device Lost、服务重启、缓存损坏 |

### P1-QA-04：30 分钟稳定性测试

固定操作循环必须包含：

- 页面切换；
- 连续平移和缩放；
- 创建、拖动、复制、删除；
- 文本输入、IME、Undo/Redo；
- 图片导入和取消；
- 保存和刷新；
- 一次 Worker crash；
- 一次 GPU Device Lost；
- 一次 Document/Asset Service 重启。

记录开始/结束 Document Hash、accepted revision、pending 数量、WASM/CPU/GPU 内存、Long Task、P95、console 和诊断事件。

Done：文档无损坏；恢复后客户端/服务端一致；无未处理异常；内存回到预算内且无持续单调增长。

### P1-QA-05：B1 输入到画面延迟

性能指标必须测量用户输入事件到对应画面呈现，不得用 Worker `render()` CPU 时间替代。

分别采集：

- 画布拖动；
- 指针锚定缩放；
- 节点拖动；
- 文本输入；
- IME commit。

每项预热 30 秒、运行至少三轮，保存每轮和中位 P50/P95/Max、输入积压、帧间隔和主线程 Long Task。

Done：B1 常规操作中位 P95 `< 50 ms`，没有持续输入积压。

### P1-QA-06：缺陷审计与签字

- P0：数据丢失、安全问题、文档不可恢复、编辑器无法启动；
- P1：核心功能错误、明显渲染错误、撤销或对账破坏数据；
- P2/P3：必须记录负责人、截止日期和不阻塞理由；
- GitHub 没有 Issue 不能替代缺陷审计；验收报告必须显式写明缺陷集合；
- 验收人必须不是相关功能实现者。

Done：无开放 P0/P1，验收人和技术负责人签字。

### P1-QA-07：阶段完成记录

通过全部 Gate 后新增：

- `verification/phase1/completion.md`；
- 更新 README 当前阶段与路线图；
- 更新兼容矩阵，只有真正闭环的维度才能从 `Partial` 改为 `Supported`；
- 记录冻结的 Snapshot schema、protocol version、engine semantics version 和核心 Fixture Hash；
- 明确转入 Phase 2 的已知 P2/P3 及负责人。

禁止在所有 Gate 通过前提前修改 README 为“进入 Phase 2”。

---

## 12. 建议提交拆分

为降低审查和回滚风险，按以下边界提交：

1. `ci(phase1): restore required verification gates`
2. `test(protocol): add phase 1 migration and operation recovery evidence`
3. `feat(assets): complete isolated decode and storage lifecycle`
4. `test(assets): cover hostile resources caching and recovery`
5. `feat(text): complete deterministic shaping editing and rasterization`
6. `test(text): add multilingual variable-font and ime evidence`
7. `feat(rendering): move browser execution onto the frozen render graph`
8. `feat(rendering): complete atlas budgets and device-loss rebuild`
9. `test(phase1): add gate performance golden and recovery evidence`
10. `docs(phase1): record phase completion and phase 2 entry`

每个提交必须独立通过其责任域测试；最后两个提交只能在完整 Gate 通过后创建。

## 13. 每个任务的完成检查模板

```markdown
### Task ID

- Owner:
- Reviewer:
- Commit:
- Requirement:
- Changed files:
- Automated tests:
- Manual procedure:
- Environment:
- Fixture and hash:
- Expected:
- Actual:
- Metrics:
- Evidence:
- Defects:
- Result: PASS | FAIL | BLOCKED
- Sign-off:
```

## 14. 最终 Go / No-Go 清单

### 自动门禁

- [ ] GitHub `main` 所有必需 Job 通过
- [ ] pnpm frozen install、lint、Vitest、Next build 通过
- [ ] Protobuf/WASM 重新生成后无 diff
- [ ] Cargo workspace 与 native wgpu feature 测试通过
- [ ] Document/Asset API 和 Mock Backend 通过
- [ ] 五类 Phase 1 Fixture 校验通过

### 功能门禁

- [ ] 1.1–1.4 Document/Operation 纵向闭环 PASS
- [ ] 1.5–1.6 Asset 纵向闭环 PASS
- [ ] 1.7–1.8 Text 纵向闭环 PASS
- [ ] 1.9–1.10 Rendering/GPU 纵向闭环 PASS
- [ ] 1.11 综合验收 PASS

### 人工与阶段门禁

- [ ] 核心 Golden 独立审核并冻结
- [ ] B1 P95 输入到画面延迟 `< 50 ms`
- [ ] 综合 Fixture 连续编辑 30 分钟通过
- [ ] 无开放 P0/P1
- [ ] P2/P3 已记录负责人和期限
- [ ] Phase 1 独立验收人签字
- [ ] 技术负责人批准阶段切换
- [ ] `verification/phase1/completion.md` 已提交

只有以上项目全部勾选，结论才是 **GO：进入 Phase 2**。任何一项未完成，结论均为 **NO-GO：继续收口 Phase 1**。

## 15. 需求与现有证据索引

- [分阶段实施与人工验收路线](../figma-like-canvas-rust-wasm-webgpu-architecture.md#23-分阶段实施与人工验收路线)
- [Phase 1 与 Phase 2 需求](../figma-like-canvas-rust-wasm-webgpu-architecture.md#phase-1联机就绪的图形内核)
- [当前兼容矩阵](compatibility-matrix.md)
- [Phase 1 原生 wgpu 证据](../verification/phase1/1.11/native-wgpu-executor.md)
- [Phase 1 服务恢复证据](../verification/phase1/1.11/service-recovery.md)
- [Phase 1 组合渲染 Fixture](../verification/phase1/1.11/render-composite-fixture.md)
- [Phase 0 完成记录格式参考](../verification/phase0/completion.md)
