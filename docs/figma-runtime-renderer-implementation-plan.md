# Figma 运行时与渲染层对齐实施方案

- 状态：M0–M7 的已声明 Runtime/Render/Prototype/Plugin/Widget 基线已完成并通过回归；外部 Figma Render Oracle 与 MCP reference 链路保留为按需增强，不阻塞当前版本验收
- 日期：2026-09-12
- 目标：使本项目能够通过 API 在 Canvas 中构建设计稿，并逐步达到可编辑、可播放、可导出、可验证的 Figma 兼容体验
- 关联文档：[36 种图层与 Figma Plugin API Node 的对齐复核](./figma-plugin-node-alignment-review.md)、[Phase 2：Figma API 对齐与真实交付实施规格](./phase2-figma-api-delivery-spec.md)

## 1. 执行结论

当前项目已经具备“通过内部命令创建 Figma 对应节点并写入 Canvas”的数据基础，但还不能把这件事等同于“具备完整的 Figma Plugin API 运行时”或“具备 Figma 级原型播放与渲染”。

建议采用下面的目标分层：

| 能力层级 | 完成标准 | 当前判断 |
| --- | --- | --- |
| L1 API 建稿 | 调用受支持 API 创建、修改、排序、保存节点，刷新后结果一致 | 基础已具备，缺统一运行时外观与部分对象 API |
| L2 API 编辑 | 节点是有身份和生命周期的活对象；容器、文本、资源、导出 API 具有稳定语义 | M1/M2 核心范围已完成；完整 Plugin API 仍属后续增量 |
| L3 原型播放 | Reaction、Action、导航、Overlay、Transition 可确定性执行 | P0 已完成；Dissolve/Directional 与已声明 Smart Animate 基线走共享 Render IR |
| L4 视觉一致 | Canvas、导出与 Figma 参考图在已声明能力范围内通过 Golden Gate | P0 和已声明的 M6 子集完成；高级排版、远程内容及未公开渲染语义仍有明确 fallback |
| L5 插件兼容 | 典型 Figma 插件可在受控沙箱中运行，无需改写核心业务逻辑 | M7 安全基线已完成；完整第三方 Plugin API 仍需独立项目 |
| L6 Widget 兼容 | Widget JSX、同步状态、事件/hooks 和协作合并可运行 | 声明式 Widget Runtime 与协作基线已完成；JSX/完整 Figma Widget 兼容仍属独立子项目 |

近期最合理的交付目标是 **L2 + L3 的核心子集 + L4 的常用设计节点**，而不是立即宣称完整兼容 Figma。完成这部分后，外部调用方可以稳定地用 API 构建设计稿原型，并在本项目中预览、交互和导出。

### 当前版本范围决策（2026-09-12）

当前没有与 `api-prototype-card-flow` 或 `F-M6-SPECIAL-NODES` 一一对应的 Figma 节点。因此，已实现的 Figma Images REST Oracle 与 Figma MCP reference 链路保留为后续增强，**不再作为本版本发布门槛**。当前必须通过的是项目内固定 fixture 的 Geometry/Layout/Semantic/Browser Golden 门禁；若未来提供同源 Figma 节点，则必须另行运行外部对照、提交 sidecar 和差异说明。该决策不构成对未对照节点的 Figma 像素级一致性声明。

在进入 Node Proxy、Reaction 或新 Render Pass 的功能实现前，必须先冻结三个不可后补的架构契约：

1. **运行时可见性契约**：同步 API 必须支持 read-your-writes；待提交 Projection、同步预校验、flush、Ack、失败回滚和 Undo 分组具有确定性。
2. **Revision 租约契约**：Player 和 Export 不只记录 Revision 数字，还必须持有可读取的冻结 Snapshot、派生几何和资源租约。
3. **有序渲染契约**：Render IR 以 Canonical stacking context 和有序 display list 为主轴；按材质或节点类型 batching 不得改变 z-order，Background Blur 必须显式依赖 backdrop。

因此本文的执行状态含义是：**可以从 M0A–M0C 开始实施；在三项门禁通过前，不应并行落地依赖其语义的 Proxy、Player 和 Render Graph PR。**

### 当前实施进展（2026-08-25）

已完成可独立验证的 M0 基础语义：锁定 `@figma/plugin-typings@1.134.0`、Capability/Error/UX contract、`RuntimeProjectionStore` 的 PendingProjection 与 Ack/Projection fence、冲突策略、`RevisionLeasePool` 以及有序 Render IR 的顺序/组边界约束。M1 已落地 RuntimeSession、NodeRegistry、P0 Node/Container Proxy、Figma-compatible facade 与 Worker Ack/Snapshot bridge；统一校验入口为 `pnpm check:m1-runtime`。该检查覆盖 TypeScript contract、Runtime 单测和现有 Worker 协议测试；真实浏览器 Worker 已通过嵌套卡片提交、图层顺序与子节点几何、Undo、Auto Layout flow，以及 Canonical 快照 hydrate 后的 hash 一致性验收，M1 在本文声明的核心范围内完成。

M2 的异步资源/文本核心范围与 M3 的原型 P0 也已完成。M3 将受限的 Reaction、Trigger、Action、Transition 与 Frame metadata 通过 append-only protobuf 操作、Core Canonical extension、WASM、TS projection 和 Node Proxy 串接；`setReactionsAsync()` 与 metadata 写入均走同一 Ack/Projection fence。`PrototypePlayer` 固定 RevisionLease，支持 Click/Press/Hover/Timeout、Navigate/Overlay/Back/Close/URL、导航历史、Overlay stack、同租约 hit test、资源预取 hook、键盘 Tab/Enter/Space、Esc、焦点恢复、outside-click 和 reduced-motion。删除目标会在同一 Core 事务中把引用置空，Undo 会恢复引用。M4 以固定 revision 的共享 `OrderedRenderScene` 接管 Canvas、WebGPU 输入顺序、Hit Test 与 SVG；Transition compositor 已实现 Dissolve/Directional 的双 surface 合成计划。`exportAsync({ format: "SVG_STRING" })` 由独立 RevisionLease 固定确认态 Projection，并拒绝缺少 Canvas 字段的窄投影。浏览器 `/runtime-harness` 已在真实 Worker 中验证 Reaction 持久化、Enter 导航、冻结 revision、SVG 冻结导出；Core、WASM、document codec/service 和 Runtime 回归均通过。Dissolve/Directional 是确定的 cross-fade/位移动画，不能误称为视觉级 Smart Animate。

这不是 M0 的全部退出声明：M0A 的 Figma 对照 Fixture 与基线元数据、M0B 的真实 Transaction client/Worker fence/Undo 组、M0C 的 Scene Compiler、Canvas fallback、Alpha Mask、真实 Background Blur 与 Device Lost 后端重建，仍须按后续 PR 接入并以集成或视觉测试验证。

## 2. 范围与非目标

### 2.1 本方案要交付

1. 一个 Figma 风格但受能力声明约束的运行时入口，包括 `root`、`currentPage`、节点查询、节点创建、选择、字体、图片、导出和事件。
2. 有稳定身份、可失效、可事务写入的 Node Proxy，而不是一次性的节点 JSON。
3. 页面按需加载、字体/图片加载和导出的异步任务模型。
4. Reaction/Action/Transition 的 Canonical 数据模型和原型播放器。
5. 从 Canonical Snapshot 到 Render Scene、各渲染 Pass、Hit Test 和导出的统一投影。
6. 常用 Design 节点的高保真渲染，以及特殊节点的明确降级策略。
7. 以 Figma REST JSON 和 Figma 节点渲染结果为外部参照的兼容性与视觉回归工具。
8. 每个能力都具有支持矩阵、错误码、测试和退出门槛。

### 2.2 本方案不承诺

- 读取或写入 Figma 私有 `.fig` 文件格式。
- 复制 Figma 未公开的内部渲染器、布局求解器或 Smart Animate 匹配算法。
- 第一阶段直接运行任意第三方 Figma 插件。
- 第一阶段实现多人 Presence、评论、完整版本历史和 Figma 团队库服务。
- 将所有 FigJam、Slides、Buzz、Widget 节点都渲染成 Figma 产品级效果。
- 对不支持的 Paint、Effect、Mask、字体或节点静默近似为另一种能力。

## 3. 官方公开资料能提供什么

Figma 有足够公开文档帮助定义外部契约，但没有公开其完整编辑器运行时和渲染器实现。

| 官方资料 | 可作为本项目的契约 | 不能从中获得 |
| --- | --- | --- |
| [Plugin API 概览](https://developers.figma.com/docs/plugins/) | 插件可读写文件；文件是节点树；页面动态加载；页面、字体、图片等关键操作是异步的 | 事务提交、内部缓存、排版和渲染算法 |
| [Plugin API Reference](https://developers.figma.com/docs/plugins/api/api-reference/) | 全局对象、节点类型、共享属性、数据联合类型、最新版 typings | 节点对象在 Figma 内部如何存储和同步 |
| [Accessing the Document](https://developers.figma.com/docs/plugins/accessing-document/) | `root/currentPage/selection`、页面加载、遍历和查询行为；未加载页面的访问限制 | 页面分块、增量加载和索引的内部格式 |
| [Dynamic Page Loading](https://developers.figma.com/docs/plugins/migrating-to-dynamic-loading/) | Document/Page 查询在未加载时的抛错行为、`loadAllPagesAsync()` 与持续全页观察语义 | 本项目 Page Chunk 的调度、缓存和淘汰算法 |
| [Node `x`](https://developers.figma.com/docs/plugins/api/properties/nodes-x/) | `x/y` 是同步可写属性；Auto Layout flow child 上写入可能 no-op | 本项目 world/local transform 与 Core reflow 的实现 |
| [`figma.on`](https://developers.figma.com/docs/plugins/api/properties/figma-on/) | `documentchange` 的异步合并、payload、dynamic-page 门禁和 selection/currentPage 事件行为 | 本项目 transaction accepted、Projection fence 和远端 delta 内部协议 |
| [Reaction](https://developers.figma.com/docs/plugins/api/Reaction/) | Reaction 必须包含 Trigger 和非空 Actions；旧的单 `action` 已废弃 | 多 Action 调度、事件传播和冲突处理的内部实现 |
| [Action](https://developers.figma.com/docs/plugins/api/Action/) | NODE/URL/BACK/CLOSE/变量/条件等公开联合类型和 nullable/overlay/reset 字段 | 播放器内部队列、状态机和变量求值器 |
| [Transition](https://developers.figma.com/docs/plugins/api/Transition/) | Transition、方向、时长、Easing、Smart Animate/匹配层的公开字段 | Smart Animate 的完整层匹配和插值细节 |
| [Export Settings](https://developers.figma.com/docs/plugins/api/ExportSettings/) | PNG/JPG/SVG/SVG_STRING/PDF/JSON_REST_V1 的字段、默认值和返回类型 | 编码器、字体 outline、颜色转换和 PDF 栅格/矢量实现 |
| [Widget + Plugin API](https://developers.figma.com/docs/widgets/using-the-plugin-api/) | Widget API 描述 Canvas UI；Plugin API 只应在事件处理器和 hooks 中调用 | Widget reconciler、协作同步和运行隔离的内部机制 |
| [REST file endpoints](https://developers.figma.com/docs/rest-api/file-endpoints/) | 文件/节点 JSON、`geometry=paths`、图片 fill、节点 PNG/JPG/SVG/PDF 渲染 | 可写编辑事务和像素管线实现 |
| [API 对比](https://developers.figma.com/compare-apis/) | Plugin、Widget、REST 的用途和交互模型边界 | 三者共享的内部运行时结构 |

因此，本项目的实现策略应是：

1. 以 Plugin API 文档与 `@figma/plugin-typings` 定义对象和方法的可观察行为。
2. 以 REST JSON 验证数据映射，以 Figma 节点渲染结果作为视觉参照。
3. 对官方未公开的行为建立本项目自己的确定性规则、兼容等级和 Golden Fixture。
4. 不把“Figma 没公开实现”当作无法推进的理由，也不把推测写成官方行为。

## 4. 当前项目基线

### 4.1 已有能力

| 领域 | 当前资产 | 主要落点 |
| --- | --- | --- |
| Canonical 文档 | Rust 文档树、36 种 `NodeKind`、Revision、Hash、Tombstone、资源索引 | [`editor-core`](../crates/editor-core/src/lib.rs) |
| 持久化协议 | Append-only Protobuf、Page Chunk、SceneNode、资源、Operation Envelope/Ack | [`editor.proto`](../schemas/proto/editor/v1/editor.proto) |
| 事务 | Worker 将 UI intent 解析为 Core batch；Rust 原子提交；Undo/Redo、远端回放与冲突处理 | [`editor.worker.ts`](../src/workers/editor.worker.ts)、[`transaction-batch.ts`](../src/lib/transaction-batch.ts) |
| Figma 节点边界 | 36 种节点类型的只读投影，以及受限写入到 `EditorCommand` 的适配 | [`figma-plugin-node-projection.ts`](../src/lib/figma-plugin-node-projection.ts)、[`figma-plugin-node-mutation.ts`](../src/lib/figma-plugin-node-mutation.ts) |
| Figma REST 导入 | 不可信 JSON 预检、节点/页面计划、图片资源两阶段绑定、兼容报告 | [`figma-rest-import.ts`](../src/lib/figma-rest-import.ts) |
| 几何 | VectorPath、Boolean、Stroke mesh、Hit Test 共用 Rust 几何语义 | [`geometry.rs`](../crates/editor-core/src/geometry.rs)、[`hit-test.ts`](../src/lib/hit-test.ts) |
| 渲染计划 | Revision 绑定的不可变 Scene、Dirty Set、固定 Pass 顺序、GPU 资源预算和 Device Lost 恢复 | [`renderer-wgpu`](../crates/renderer-wgpu/src/lib.rs)、[`rust-render-graph.ts`](../src/lib/rust-render-graph.ts) |
| 文字和字体 | Style Run、字体资源注册、字体回退链、Rust shaping/raster、Glyph Atlas | [`font-face-registry.ts`](../src/lib/font-face-registry.ts)、[`rust-text-layout.ts`](../src/lib/rust-text-layout.ts)、[`rust-glyph-raster.ts`](../src/lib/rust-glyph-raster.ts) |
| 图片与导出 | 资源准入、Bitmap Cache、SVG/PNG/PDF、Slice、冻结 Revision 和 fallback manifest | [`svg-export.ts`](../src/lib/svg-export.ts)、[`slice-export.ts`](../src/lib/slice-export.ts)、[`export-manifest.ts`](../src/lib/export-manifest.ts) |

### 4.2 关键差距

1. **Runtime 已完成核心子集，但不是完整 Plugin API。** `RuntimeSession`、Node Proxy、对象身份、失效状态、容器操作及 Ack/Projection fence 已落地；36 种 Canonical 节点的完整活对象 API 仍不能由只读投影自动推导。
2. **Runtime 与编辑器入口已在核心路径汇合，但非 Runtime 调用方仍有边界。** M1–M2 API 写入走 `RuntimeSession → Transaction → Ack`；导入、编辑器手势和未来 Plugin API 的完整命令面仍需按各自权限与冲突语义接入，不能借用 Runtime 内部方法绕过门禁。
3. **异步资源核心已完成，进度与广义权限仍是扩展。** 页面、字体、图片、取消、超时和 Runtime Error 已有稳定契约；细粒度进度、远端下载授权与所有资源类别尚未成为通用 Runtime API。
4. **P0 原型播放与 Render IR 合成已完成。** 当前差距是变量/条件/滚动、真实媒体、未公开的完整 Smart Animate 规则及更完整的变体属性模型，而不是基础导航、Overlay 或 Dissolve/Directional 合成。
5. **Scene Compiler 已提供共享 paint/hit/export 顺序，但特殊节点只覆盖声明的 M6 子集。** 未表达或未公开的图形、富文本及 Transform modifier 保持诊断 fallback，不应以 NodeKind 已存在推断为已渲染。
6. **P0 Paint、Mask、Effect 与 Blend 已有明确合成路径。** Noise、Texture、Glass、Shader、视频/远程内容等高阶效果仍须单独定义资源、预算与隔离策略。
7. **Canvas、Hit Test 与 SVG/PNG 已共享主要 P0/M6 几何边界。** 复杂 TextPath、富 Connector 标签、非线性或不安全 TransformGroup 及远程内容仍会产生结构化 fallback；这些是刻意保留的语义边界，不是静默分叉。
8. **外部 Figma Render Oracle 与离线 baseline 工具已具备，但真实对照为可选增强。** 当存在同源 Figma 文件、节点与参考图时，可证明特定 fixture 的 geometry/layout/color/pixel 门槛；当前版本以项目内固定 fixture 的离线门禁为权威，普通 CI 不持有实时访问凭据。

## 5. 目标架构

```text
API 调用方 / 未来插件沙箱 / 编辑器 UI
                  │
                  ▼
         FigmaCompatibleRuntime
   ┌──────────────┼──────────────┐
   │              │              │
NodeProxy     RuntimeSession   AsyncServices
Registry      + Capability     Page/Font/Image/Export
   │              │              │
   └──────────────┴──────────────┘
                  │
                  ▼
      ConfirmedProjection + PendingWriteSet
      同步 read-your-writes / Ack 后提交或回滚
                  │  只生成命令，不直写 Canonical
                  ▼
      Transaction Builder / Worker Bridge
                  │
                  ▼
       Protobuf Operation / Rust Reducer
                  │
          Canonical Revision + Delta
        ┌─────────┼──────────┐
        ▼         ▼          ▼
   Node/Event   Scene      Revision Lease
   Projection   Compiler   Player/Export Snapshot
                  │
                  ▼
  Shape → Image → Text → Effect/Mask → Overlay → Composite
                  │
                  ▼
          WebGPU / Canvas fallback
```

必须遵守四条边界：

1. Node Proxy 不持有独立文档副本，只持有 `sessionId + nodeId + generation`；待提交写入集中存放在 Session 的 `PendingWriteSet`。
2. 所有持久化修改必须进入同一 Core Transaction；Ack 前不得发出 committed change 事件。
3. Scene、Glyph Atlas、Bitmap、离屏表面、播放器帧都是派生状态，不进入 Snapshot 或 Hash。
4. 渲染、Hit Test 和导出消费同一 Revision 的 Canonical 投影，禁止跨 Revision 混用缓存。
5. 同步 API 在一个 Session 内必须读取 `ConfirmedProjection ⊕ PendingWriteSet`；Core Ack 是持久化权威，但不能破坏同步对象 API 的调用时可见性。
6. Player/Export 通过 `RevisionLease` 固定可读取输入及资源生命周期；仅保存 `sourceRevision` 数字不构成冻结。

## 6. 运行时层实施设计

### 6.1 建议模块

首批新增文件建议集中在 `src/runtime/`，避免继续把运行时语义堆入 `editor.worker.ts`：

| 模块 | 职责 |
| --- | --- |
| `figma-compatible-runtime.ts` | 对外入口；暴露 root/currentPage、创建、查询、字体、图片、事件和关闭语义 |
| `runtime-session.ts` | editorType、权限、当前 Revision、currentPage、selection、生命周期和任务所有权 |
| `node-registry.ts` | 同一 session 内 `(nodeId, generation) → NodeProxy` 身份唯一；删除与 Undo 恢复不复活旧引用 |
| `node-proxy.ts` | 属性 getter/setter、类型收窄、`remove/clone/resize` 等通用行为 |
| `container-node-proxy.ts` | children、append/insert、reparent、findAll/findOne/findChildren |
| `runtime-projection-store.ts` | Confirmed Projection、PendingWriteSet、read-your-writes、generation 和 Ack/rollback fence |
| `runtime-transaction-client.ts` | 将运行时写入组成原子 batch，等待 Worker Ack，按命令策略重建 Revision 冲突 |
| `runtime-events.ts` | selectionchange、currentpagechange、documentchange、close 等事件 |
| `runtime-errors.ts` | 稳定错误码、安全消息、是否可重试和诊断上下文 |
| `runtime-capabilities.ts` | 按 editorType、node type、权限和实现等级进行能力判断 |
| `runtime-task-queue.ts` | 页面、字体、图片、导出等异步任务的去重、取消、超时和关闭 |
| `revision-lease.ts` | 为 Player/Export 固定 Canonical Projection、派生几何、字体/图片引用和释放策略 |

这些文件是建议落点，不要求第一笔 PR 重构现有 Worker。首阶段可保留 Worker 作为唯一提交和渲染宿主，通过一个窄的 Runtime Message 协议接入。

### 6.2 Node Proxy 身份与生命周期

Node Proxy 必须满足：

- 同一个 `RuntimeSession` 中，相同 live generation 的 Node ID 始终返回同一个 Proxy 实例。
- 不同 Session 的 Proxy 不共享可变状态。
- Proxy getter 从 `ConfirmedProjection ⊕ PendingWriteSet` 读取，不缓存过期的完整节点 JSON。
- setter 先进行确定性的同步预校验，再写入 Session 级 PendingWriteSet；它不直接改 Canonical，也不等待 Worker。
- `remove()` 进入 PendingWriteSet 后，当前 Session 立即观察到 `removed = true`；允许继续读取 `id/type/removed`，其他结构或写操作抛出稳定的 `NODE_REMOVED`。
- Undo 恢复相同 Node ID 时，不复活旧 Proxy；Registry 创建新 generation，防止旧引用意外写入。
- 关闭 Runtime 后所有 Proxy 失效，错误为 `RUNTIME_CLOSED`。
- `getNodeByIdAsync()` 在 Undo 恢复后返回新 generation；旧引用保持 `removed = true`。

建议内部 Handle：

```ts
type NodeHandle = Readonly<{
  sessionId: string
  nodeId: string
  generation: number
}>
```

### 6.3 属性读写

按四类处理：

1. **同步只读观察值**：`id/type/parent/absoluteTransform/absoluteBoundingBox`。
2. **同步可写值**：`x/y/name/opacity/rotation/...`；写入 PendingWriteSet，同一调用栈内后续 getter、容器操作和查询必须观察到新值。`x/y` 按 Figma 契约可写；Auto Layout flow child 上的 no-op/拒绝行为必须在 capability matrix 中逐项声明。
3. **同步创建和树操作**：`create*()/appendChild()/insertChild()/remove()/clone()` 可引用同一 PendingWriteSet 中尚未 Ack 的节点，并保持 Proxy 身份。
4. **显式异步操作**：页面加载、字体加载、远端图片创建、跨页加载、导出、组件/库导入。

为了防止连续 setter 产生多次 Revision，运行时应提供同一调用栈内的 microtask 合并：

```ts
node.x = 100
node.y = 200
node.opacity = 0.8
await runtime.commitAsync() // 一个 batch、一次 revision、一次 transactionaccepted；documentchange 进入异步合并队列
```

必须定义以下 flush 边界：

- 当前同步调用栈结束后的 microtask 自动 flush。
- 显式 `runtime.commitAsync()` 立即 flush 并等待 `Ack + acceptedRevision Projection` 双重 fence。
- 需要依赖 Core 计算结果的异步 API 在开始前 flush 前置写入。
- Runtime close 默认尝试 flush 已通过同步预校验的写入；宿主强制终止则整体丢弃尚未发送的 PendingWriteSet。

同步预校验负责类型、范围、权限、已知父子限制和当前 PendingProjection 内的环检测；Core 仍是最终裁决。Core 拒绝时必须整体移除该 batch 的 PendingWriteSet、恢复前一 confirmed view、拒绝对应 `commitAsync()`，并通过带 `transactionId` 的项目 `runtime.error` 报告；不得把回滚伪装成第二次 `documentchange`。

该 PendingProjection 模式是 L2 的前置条件，不是未来第三方插件阶段的可选优化。它保持 Canonical-first：本地投影仅提供调用时可见性，持久化和 committed event 仍以 Core Ack 为准。

### 6.4 Transaction、Ack 与冲突重建

每个待提交 batch 必须携带 `transactionId/baseRevision/readSet/writeSet/commandPolicy`。命令按冲突策略分为：

| 策略 | 示例 | 冲突处理 |
| --- | --- | --- |
| `retry-safe` | 对同一不可变资源按 hash 去重注册 | 可在新 baseRevision 上幂等重试 |
| `rebase-required` | update、文本 range、reparent、insert、clone | 获取新 confirmed Projection 后重新生成命令与 readSet |
| `non-retryable` | 依赖一次性外部授权或用户确认的操作 | 返回 `REVISION_CONFLICT`，由调用方决定重试 |

禁止仅替换 `baseRevision` 后原样重发基于旧 Projection 计算的命令。`PositionId`、保持 world transform 的 reparent、UTF range、父子约束和目标存在性都必须重新求值。

Ack 成功不等于 getter 已经可读取新状态。Runtime 只有在同时观察到 `acceptedRevision` 及该 Revision 的 Projection 后，才能：

1. 将 PendingWriteSet 合入 confirmed view。
2. resolve `commitAsync()`。
3. 发出 transaction accepted 项目事件。
4. 将对应 Canonical delta 放入兼容 `documentchange` 的异步合并队列。

Worker/Service 必须按 `transactionId` 幂等：重复 envelope 返回第一次结果，不产生第二个 Revision 或 Undo entry。

### 6.5 容器与树操作

P0 支持：

- `children`
- `appendChild(node)`
- `insertChild(index, node)`
- `findChildren(predicate)`
- `findOne(predicate)`
- `findAll(predicate)`
- `remove()`
- `clone()`

约束：

- `children` 按 Canonical `PositionId` 排序。
- reparent 必须保持 world transform，复用现有 `reparent` 事务。
- Page、SlideGrid、SlideRow、ComponentSet、Table 等类型的子节点限制由 Rust Core 作为最终裁决。
- Container/Page 的同步 `find*` 只遍历已完整加载的当前 subtree；Page 未加载时抛出 `PAGE_NOT_LOADED`。
- DocumentNode 的 `findAll/findOne/findAllWithCriteria` 在 dynamic-page 模式下，未先调用 `loadAllPagesAsync()` 时必须抛错，禁止静默返回仅包含已加载页的部分结果。
- 兼容 `findAll/findOne/findChildren` 保持同步返回；predicate 在当前运行时对固定的 scope snapshot 执行，不能传入 Worker，也不能在遍历中观察到中途提交的新 Revision。
- 超过同步遍历预算时整体抛出 `RESOURCE_LIMIT`，不得返回截断结果。本项目如需大文档流式检索，另提供不属于 Figma 兼容面的 `runtime.queryNodesAsync()` 分页 API。
- `findAll` 明确使用 pre-order traversal，父节点先于子节点；顺序与 `children` 一致。

### 6.6 页面加载与 Session/编辑器状态所有权

运行时需要显式页面状态：

```ts
type PageLoadState = "unloaded" | "loading" | "loaded" | "failed"
```

行为规则：

- 当前页启动时必须为 `loaded`。
- 未加载 Page 可读取最小元数据，但访问 `children` 抛出 `PAGE_NOT_LOADED`。
- `page.loadAsync()` 去重并复用同一 in-flight Promise。
- `setCurrentPageAsync()` 先加载，再原子更新 Runtime currentPage；失败时不改变当前页。
- `loadAllPagesAsync()` 顺序或限并发加载，并允许取消；不得同时展开全部渲染 Scene。
- 页面加载只改变 Runtime/Projection 可用性，不产生文档 Revision。
- `loadAllPagesAsync()` 建立持续的全页观察租约：后续由其他客户端新增的 Page 也必须进入该 Session 的加载/事件范围，直到 Session 关闭。

如果当前本地 Snapshot 总是完整加载，可先以“逻辑加载状态”实现契约，再在后续接入真实 Page Chunk 拉取。

`currentPage` 和 `selection` 是编辑器共享 view state，不是每个 Session 各自拥有的私有副本。多 Session 规则：

- Worker 中的 `activePageId/selectedIds` 是唯一权威；Session 只保存已观察的版本和事件订阅。
- 任一具有 view-state 权限的 Session 或用户 UI 更新后，所有 Session 在同一 view-state sequence 上收到异步事件。
- `setCurrentPageAsync()` 与 selection 写入使用独立的 view-state sequence，不增加文档 Revision，也不进入文档 Undo。
- 同一 tick 的连续 selection 写入可合并；切页成功必须同时产生 `currentpagechange` 和 `selectionchange`。
- Runtime 关闭不清空编辑器 selection；仅释放该 Session 的订阅、任务和 PendingWriteSet。
- 无头 API Session 可声明 `isolatedViewState`，但该模式属于项目扩展，不能伪装为共享 Figma `currentPage/selection`。

### 6.7 字体与图片

现有 `FontFaceRegistry` 可作为底层实现，但运行时还需增加：

- `listAvailableFontsAsync()` 的受限目录。
- `loadFontAsync(fontName)` 到 Asset ID/FontReference 的解析。
- 文本写入前的 font gate；未加载字体时返回 `FONT_NOT_LOADED`，不能悄悄换字体后持久化。
- UTF-16 Plugin API range 与 Canonical UTF-8 byte range 的双向转换。
- 图片 `createImage/createImageAsync/getImageByHash` 风格接口，以及内容哈希去重。
- 资源下载、解码、尺寸探测、文档 attachment 和节点绑定分离；外链 URL 不进入 Canonical 文档。
- Runtime 关闭时取消未提交任务，但不得撤销已由 Asset Service 准入的不可变资源。

### 6.8 事件

首批事件：

| 事件 | 触发时机 | 数据来源 |
| --- | --- | --- |
| `documentchange` | 异步合并一个或多个已确认 Canonical delta 后 | `DocumentChange[]` + origin；dynamic-page 下需先建立全页观察租约 |
| `selectionchange` | Runtime/编辑器 selection 确认更新后 | Worker view state |
| `currentpagechange` | 页面加载并切换成功后 | Runtime session |
| `close` | 主动关闭、超时或宿主终止 | Runtime session |
| `runtime.transactionaccepted` | 一笔 transaction 通过 Ack + Projection fence 后；项目扩展 | transactionId + acceptedRevision |
| `runtime.error` | 异步任务或不可恢复提交失败；项目扩展 | Runtime error boundary |

兼容事件与项目事件必须分离：

- `documentchange` 保持 Figma 的异步、可合并语义，不承诺“一笔 transaction 对应一次回调”。
- `documentchange` payload 至少区分 CREATE、DELETE、PROPERTY_CHANGE，并标注 local/remote/user 等可观察 origin。
- 在 `documentchange` callback 内由同一 Session 直接产生的修改不得造成无界递归；具体抑制规则进入事件契约测试。
- dynamic-page 模式未调用 `loadAllPagesAsync()` 时不开放全局 `documentchange`；优先提供 Page 级 nodechange 作为后续细粒度能力。
- 禁止在 PendingProjection 时发出 committed `documentchange`；回滚不应伪装成第二次用户修改。
- 需要精确等待一笔提交的本项目调用方使用 `commitAsync()` 或 `runtime.transactionaccepted`，不能依赖 `documentchange` 次数。

### 6.9 错误模型

P0 错误码建议：

```ts
type RuntimeErrorCode =
  | "RUNTIME_CLOSED"
  | "NODE_NOT_FOUND"
  | "NODE_REMOVED"
  | "PAGE_NOT_LOADED"
  | "UNSUPPORTED_NODE_TYPE"
  | "UNSUPPORTED_PROPERTY"
  | "UNSUPPORTED_FEATURE"
  | "INVALID_ARGUMENT"
  | "FONT_NOT_LOADED"
  | "RESOURCE_UNAVAILABLE"
  | "RESOURCE_LIMIT"
  | "TASK_CANCELLED"
  | "TIMEOUT"
  | "URL_NOT_ALLOWED"
  | "PERMISSION_DENIED"
  | "REVISION_CONFLICT"
  | "REVISION_LEASE_EXPIRED"
  | "TRANSACTION_ABORTED"
  | "EXPORT_FAILED"
  | "INTERNAL_ERROR"
```

所有错误都包含 `code`、安全消息、`retryable`、可选 `nodeId/transactionId/revision`；实现细节和外部 token 不得进入插件可见错误。同步 setter 的确定性输入错误必须在调用点抛出；异步 Core/资源错误通过对应 Promise 拒绝和项目 `runtime.error` 报告，不能只写日志。

## 7. Canonical 协议补充

### 7.1 需要持久化

优先为普通 Scene Node 增加原型字段：

```ts
type Reaction = {
  trigger: Trigger
  actions: Action[] // 至少一个
}

type Trigger =
  | { type: "ON_CLICK" | "ON_PRESS" | "ON_HOVER" | "ON_DRAG" }
  | { type: "AFTER_TIMEOUT"; timeout: number }
  | { type: "MOUSE_ENTER" | "MOUSE_LEAVE" | "MOUSE_UP" | "MOUSE_DOWN"; delay?: number }
  | { type: "ON_KEY_DOWN"; keyCodes: number[] }

type Action =
  | {
      type: "NODE"
      navigation: "NAVIGATE" | "SWAP" | "OVERLAY" | "SCROLL_TO" | "CHANGE_TO"
      destinationId: string | null
      transition: Transition | null
      preserveScrollPosition?: boolean
      overlayRelativePosition?: { x: number; y: number }
      resetVideoPosition?: boolean
      resetScrollPosition?: boolean
      resetInteractiveComponents?: boolean
    }
  | { type: "BACK" | "CLOSE" }
  | { type: "URL"; url: string }
  | { type: "UPDATE_MEDIA_RUNTIME"; destinationId: string | null; mediaAction: string; amountToSkip?: number; newTimestamp?: number }
  | { type: "SET_VARIABLE"; variableId: string | null; variableValue?: VariableData }
  | { type: "SET_VARIABLE_MODE"; variableCollectionId: string | null; variableModeId: string | null }
  | { type: "CONDITIONAL"; conditionalBlocks: ConditionalBlock[] }
```

具体联合类型必须以 M0A 锁定的精确 `@figma/plugin-typings` 版本为基线；禁止在实现期间自动跟随 `latest`。上面用于划分持久化边界，不替代编译期契约。P0 只将下列能力标记为 `supported`：

- Trigger：Click、Press、Hover、After Timeout。
- Action：Navigate、Overlay、Back、Close、URL。
- Transition：None、Dissolve、Directional。

其余 Action/Trigger 在 capability matrix 中标为 `preserved` 或 `rejected`；在变量模型、媒体运行时或滚动状态尚未实现时，不得仅因协议字段存在就标为可播放。

Frame/Slide 还需持久化独立的 Prototype metadata，至少覆盖：

- Overlay position type 与可选相对位置。
- Overlay background 与 background interaction；`dismissOnOutsideClick` 只能从该字段确定性推导。
- Overflow/scroll direction、fixed children 和初始 scroll 行为；在支持 `SCROLL_TO` 前可先 preserved。
- Prototype starting point/flow identity；若第一阶段不提供多 flow，必须给出唯一、稳定的默认入口规则。

协议演进要求：

- 在 `SceneNode` 末尾追加 `repeated Reaction reactions`，不复用旧字段号。
- 为 Trigger、Action、Transition、Easing 使用 `oneof`，同时提供显式 `OpaquePrototypeValue { type_name, payload }` 或提升 `engine_semantics_version` 并让旧引擎只读拒绝。不能假设 Prost 对未来未知 oneof tag 解码再编码后仍会保留。
- Reaction 必须在 Core 验证 `trigger != null` 且 `actions` 非空。
- `NODE.destinationId` 必须是同文档节点或 `null`。创建/编辑 Action 时，未知目标返回 `NODE_NOT_FOUND`；导入缺失引用可保存为结构化 unresolved extension，但 capability 为 `preserved`。
- 删除被 Reaction 引用的目标时，Core 在同一事务中将 `destinationId` 置为 `null` 并保留其余 Action；Undo 同时恢复目标与引用。禁止删除后留下声称有效但无法解析的 ID。
- 时长、延迟、spring、cubic bezier 和 Action 数量设置硬上限。
- 变量定义和变量值属于后续独立模型，不要先把任意 JSON 塞进 Canonical 字段。
- URL 只允许 `https:` 及明确批准的协议；解析、规范化、长度限制和宿主授权在提交时完成，实际打开仍需播放器宿主确认。

### 7.2 不应持久化

- 当前播放 Frame、导航历史、Overlay Stack。
- Transition 当前进度和插值后的临时属性。
- Hover/Pressed/Focus 状态。
- Timer Handle、事件传播标记。
- 已解析字体对象、Bitmap、纹理、Glyph 和离屏表面。
- Node Proxy、Session、Promise、取消令牌。

## 8. 原型播放器

### 8.1 播放器状态

```ts
type PrototypePlayerState = {
  sourceRevision: number
  revisionLeaseId: string
  currentFrameId: string
  navigationHistory: string[]
  overlays: Array<{
    frameId: string
    position: OverlayPosition
    dismissOnOutsideClick: boolean
    previousFocusNodeId?: string
  }>
  scrollOffsets: ReadonlyMap<string, { x: number; y: number }>
  variables?: ReadonlyMap<string, VariableData> // 变量模型实现后启用
  transition?: ActiveTransition
}
```

播放器启动时必须获取 `RevisionLease`，而不只是记录 Revision 数字。Lease 至少固定：

- 该 Revision 的 Canonical Projection/目标 flow subtree。
- Scene Compiler 输出所需的几何、文本 shaping input 和稳定 node identity。
- 字体、图片、poster 等不可变资源引用；资源 bytes 可按预算延迟加载，但 hash/授权状态固定。
- capability/fallback report 和色彩空间。

播放期间编辑器提交新 Revision 时，P0 采用“继续播放冻结 Revision，并提示重新开始”策略，避免一半节点来自旧版本、一半来自新版本。提示必须是非阻塞、可键盘操作的状态条，包含“继续当前预览”和“从最新版本重新开始”；重新开始释放旧 Lease、清空临时导航/变量/Overlay 状态，并尽量保留预览窗口尺寸。

Lease 具有内存与时长预算。播放器关闭、文档关闭或显式重新开始时释放；超出预算不得静默切换到当前 Revision，而应停止播放并显示可重试错误。GPU Device Lost 后从同一 Lease 重建派生资源。

### 8.2 事件执行顺序

```text
Pointer/Keyboard/Timer
  → 使用同 Revision Hit Test
  → 从目标向祖先收集可响应节点
  → 按 Trigger 过滤
  → 按 Reaction 顺序执行 Actions
  → 产生导航/Overlay/变量状态变化
  → 创建 ActiveTransition
  → 请求下一帧渲染
```

P0 规则：

- 单次输入最多触发一个导航型 Action，其他非冲突 Action 可按数组顺序执行。
- `BACK` 操作导航历史；`CLOSE` 优先关闭顶层 Overlay。
- URL 只能通过宿主授权的打开接口执行，禁止在 Worker 直接导航。
- Timer 在 Frame 离开时取消。
- 删除或不可见目标不响应；locked 只影响编辑，不阻止 prototype interaction。
- 事件和渲染使用相同世界变换、Clip 与 Mask 后的可点击区域。
- 导航或 Overlay transition 开始前预取目标首帧必需字体/图片；资源未就绪时显示可取消的 loading 状态，禁止先展示缺字/空白纹理再跳变。
- Overlay 打开后焦点进入 Overlay 的第一个可交互节点并限制键盘焦点；Esc 按与 Close 等价的规则关闭，关闭后恢复到触发节点。
- 点击外部关闭只在 Prototype metadata 明确允许时触发；被透明 Overlay background 覆盖的下层内容是否可点击由 background interaction 决定。
- 支持 `prefers-reduced-motion`/播放器设置：Dissolve 和 Directional 可降级为无动画，但导航、Overlay 和历史语义不变。
- Pointer、键盘、Timer 和连续输入共享单线程 action queue；转场中的取消、排队、反向或忽略策略按 Transition 类型固定并记录诊断。

### 8.3 Transition 分期

| 阶段 | 类型 | 实现要求 |
| --- | --- | --- |
| T0 | 无动画、Dissolve | 双 Surface alpha 混合；精确 duration/easing |
| T1 | Move/Push/Slide 方向动画 | 源/目标 Frame 双 Surface 变换和裁剪 |
| T2 | Smart Animate 基础 | 只匹配显式 ID 或稳定 import identity；位置、尺寸、旋转、opacity、圆角和颜色插值 |
| T3 | Smart Animate 扩展 | Paint stack、文本、Vector、Effect 和嵌套层匹配；不兼容属性使用离散切换 |
| T4 | Custom spring/scroll animate | 固定步进积分或解析公式，确保重放一致 |

Smart Animate 的官方完整匹配算法未公开。本项目必须公布自己的匹配优先级，例如：

1. 相同稳定 Node ID。
2. 相同 component/instance identity 与层路径。
3. 同一父匹配对下的同名、同类型唯一子层。
4. 否则不匹配，使用 enter/exit fallback。

每个匹配结果应可输出诊断，方便视觉回归定位。

## 9. 渲染层实施设计

### 9.1 Scene Compiler

将当前简单 `SceneNode` 扩展为“节点记录 + 有序绘制原语 + 合成边界”，避免为 36 种节点各写一条完全独立的 GPU pipeline。

建议的派生结构：

```ts
type RenderPrimitive =
  | ShapePrimitive
  | VectorPrimitive
  | ImagePrimitive
  | GlyphRunPrimitive
  | MediaPrimitive
  | EmbeddedPreviewPrimitive

type RenderItem =
  | { type: "DRAW"; nodeId: string; paintIndex: number; primitive: RenderPrimitive }
  | { type: "GROUP"; group: CompositingGroup }

type CompositingGroup = {
  stackingContextId: string
  ownerNodeId: string
  opacity: number
  blendMode: string
  clip?: ClipGeometry
  mask?: MaskChain
  effects: DerivedEffect[]
  requiresBackdrop: boolean
  orderedItems: RenderItem[] // Canonical paint order，不得按 primitive type 重排
}

type SceneSemanticNode = {
  nodeId: string
  parentId?: string
  worldTransform: Transform
  visualBounds: Bounds
  hitGeometry?: HitGeometry
  clipChain: ClipGeometry[]
  maskChain?: MaskChain
  visible: boolean
  prototypeInteractive: boolean
}
```

Scene Compiler 必须：

- 输入固定 `documentRevision` 的只读 Projection。
- 将结构节点和绘制节点分开。
- 统一计算 world transform、world bounds、clip bounds、effect outset 和 z-order。
- 用节点/祖先 delta 生成 Dirty Region；无法安全推导时退化为 full scene，而不是漏刷。
- 生成 Canvas、WebGPU、Hit Test 和 Export 可共享的 Geometry/Compositing 描述；后端可以对相邻兼容 Draw 合批，但不得跨越会改变 paint order 的 item。
- 将“语义节点索引”和“有序绘制列表”分开：Hit Test 使用前者并按同一 stacking context 逆序命中，渲染/导出使用后者。
- 对每个回退产生 `capability + nodeId + reason` 诊断。

### 9.2 Render Graph

建议从固定五个全局 Pass 演进为“有序 stacking context + 局部依赖”的执行图：

```text
ResourceUpload
  → Root Stacking Context（按 Canonical z-order 执行 orderedItems）
      ├─ Draw Shape / Image / Text / Vector（保持交错顺序）
      ├─ Child Isolated Group
      │    ├─ Capture Backdrop（仅 Background Blur 等需要）
      │    ├─ Execute Child orderedItems
      │    ├─ Apply Effect / Mask / Group Opacity
      │    └─ Composite 回父 context 的原位置
      └─ Next ordered item
  → Prototype Transition（源/目标 Frame context）
  → Editor Overlay
  → Color/Final Composite
```

Shape、Image、Text 等名称描述 pipeline/material，不是可以打乱图层的全局 z-order Pass。一个 Rectangle、Text、Image、Rectangle 交错的 fixture 必须保持该顺序；只有连续、无隔离依赖且合批不改变结果的 item 才能进入同一 GPU batch。

不是每个节点都需要离屏表面。出现以下情况时创建隔离合成组：

- 非 `NORMAL` blendMode。
- 节点级 opacity 需要对整个子树生效。
- Layer/Background Blur、Inner Shadow 或多 Effect stack。
- Alpha/Luminance/Vector Mask 链。
- Prototype Transition 的源/目标 Frame。

Background Blur 不是普通子树离屏：必须在该 item 的精确 z 位置捕获已绘制 backdrop，并在 blur 后继续后续 siblings。其 dependency 和 surface 生命周期必须进入 Render Graph 测试。

所有离屏 Surface 继续使用当前资源池预算。预算不足时只允许两种确定性行为：

1. 将完整 stacking context 在 Canvas 2D/CPU 后端离屏栅格化，再作为单张纹理回到父 context 的原 z 位置；fallback 必须保留 clip、mask、group opacity、blend 和色彩边界。
2. 整个 frame/export 返回显式 `RESOURCE_LIMIT`/compatibility error。

禁止只丢弃 Effect，也禁止在 WebGPU 与 Canvas 之间直接跳过无法表达的 backdrop/blend 依赖。

### 9.3 Paint 与颜色

P0/P1 顺序：

1. SOLID。
2. GRADIENT_LINEAR。
3. GRADIENT_RADIAL、ANGULAR、DIAMOND。
4. IMAGE fill 的 FILL/FIT/CROP/TILE 与 transform。
5. 每个 Paint 的 opacity、visible 和 blendMode。
6. 多 fills/strokes 的有序合成。

统一规定：

- Canonical 颜色不由 GPU cache 反推。
- 文档色彩空间到渲染线性空间的转换只发生一次。
- Alpha 采用明确的预乘/非预乘边界；当前 GPU instance 的 encoded-sRGB、non-premultiplied 输入契约必须在新 pipeline 中保持或版本化。
- Canvas fallback、WebGPU 和 SVG 导出使用同一 stop 排序、opacity 合并和 gradient transform。

### 9.4 Vector、Stroke、Mask 与 Hit Test

- 继续让 Rust geometry 负责 path flatten、stroke mesh、Boolean 和精确 hit test。
- 为 `VectorNetwork ↔ Canonical VectorPath` 建独立损失报告，不直接替换稳定 Point ID 模型。
- inside/outside stroke、per-side stroke、dash、cap、join 必须同时覆盖渲染、bounds、hit test 和导出。
- Mask 链的开始/结束由稳定 sibling order 推导；Mask 自身的 effect 应先完成再作为 mask source。
- Luminance/Vector Mask 在实现前不得假装为 Alpha Mask。
- Pointer hit test 必须尊重 visibility、ancestor clip、mask 和 prototype overlay 顺序。

### 9.5 文本

文本一致性优先级高于特殊节点数量，因为设计稿原型通常由大量文本组成。

必须补齐：

- 同一字体字节、variation axes、fallback chain 和 shaping input。
- UTF-8 Canonical range 与 UTF-16 API range 的稳定转换。
- line height、letter spacing、paragraph spacing、alignment、RTL/bidi。
- Text Auto Resize、Auto Layout 中的文本尺寸反馈。
- `getRange*`/`setRange*` 与 Mixed 值语义。
- TextPath 的沿路径 glyph placement。
- 缺字诊断和跨平台 fixture。
- 导出冻结 glyph placement；不能在 PNG/PDF 阶段重新测量。

### 9.6 Effect 与混合

P0：Drop Shadow、Inner Shadow、Layer Blur、Background Blur；保留 effect stack 顺序。

P1：常用 blend mode 的隔离组合；复杂 effect + blend 的嵌套合成。

P2：Noise、Texture、Glass、Shader、Progressive Blur 等较新的扩展类型。未实现时保留源字段和兼容报告。

验收不能只验证“看得到效果”，还要验证：

- effect bounds 不被裁错。
- 多 effect 顺序改变时结果相应改变。
- effect 作用于 mask source 时顺序正确。
- WebGPU 恢复后画面等价。
- Canvas fallback 和导出没有静默丢层。

### 9.7 36 种节点的渲染分组

| 分组 | 节点 | 建议实现方式 | 优先级 |
| --- | --- | --- | --- |
| 基础容器/形状 | Frame、Group、Section、Rectangle、Ellipse、Polygon、Star、Line、Slice | Shape/Vector primitive + clip/group | P0 |
| 矢量 | Vector、BooleanOperation、Highlight | Rust path/boolean/stroke mesh | P0 |
| 内容 | Text、Image paint、本地 Image、CodeBlock | Glyph/Image/shape primitives | P0 |
| 组件 | Component、Instance、Slot、ComponentSet | 渲染展开后的普通子树；编辑语义保留 identity | P1 |
| 原型 | 普通 Scene reactions、Slide、InteractiveSlideElement | Player + transition pass；互动 Slides 特殊数据先用占位 | P0/P2 |
| FigJam 基础 | Connector、ShapeWithText、Sticky、Stamp、WashiTape | 路由/参数形状/文本组合；受控纹理 | P1 |
| 表格 | Table、TableCell | 结构化 grid → shape/text primitives | P1 |
| 富媒体 | Media、Embed、LinkUnfurl | 静态 poster/preview P1；真实播放/远端激活 P2 | P1/P2 |
| 高级 | TextPath、TransformGroup | 曲线路排版；派生重复实例 | P2 |
| Widget | Widget | 独立 Widget Runtime 的渲染结果 | P3 |
| Slides 结构 | SlideGrid、SlideRow | 非绘制结构；只决定 slide 排序与播放入口 | P1 |

## 10. 导出 API

现有导出能力不能直接等同于 `node.exportAsync()`。兼容 API 的字段名、默认值和返回类型必须直接对齐 M0A 锁定的 Plugin Typings；项目扩展 manifest 使用独立方法，不能污染 `exportAsync()`：

```ts
type RuntimeExportSettings =
  | {
      format: "PNG" | "JPG"
      constraint?: { type: "SCALE" | "WIDTH" | "HEIGHT"; value: number }
      contentsOnly?: boolean
      useAbsoluteBounds?: boolean
      colorProfile?: "DOCUMENT" | "SRGB" | "DISPLAY_P3_V4"
    }
  | {
      format: "SVG" | "SVG_STRING"
      contentsOnly?: boolean
      useAbsoluteBounds?: boolean
      colorProfile?: "DOCUMENT" | "SRGB" | "DISPLAY_P3_V4"
      svgOutlineText?: boolean
      svgIdAttribute?: boolean
      svgSimplifyStroke?: boolean
    }
  | {
      format: "PDF"
      contentsOnly?: boolean
      useAbsoluteBounds?: boolean
      colorProfile?: "DOCUMENT" | "SRGB" | "DISPLAY_P3_V4"
    }
  | { format: "JSON_REST_V1" }

type RuntimeExportResult<S extends RuntimeExportSettings> =
  S["format"] extends "SVG_STRING" ? string
  : S["format"] extends "JSON_REST_V1" ? object
  : Uint8Array
```

`node.exportAsync()` 无参数时默认 PNG 1x。首阶段不支持的设置必须在调用时以稳定错误拒绝，不能忽略字段后返回看似成功的 bytes。

执行路径：

1. 校验 Node、格式、尺寸、像素和资源预算。
2. 获取 `RevisionLease`，记录 `sourceRevision` 和目标子树。
3. 在该 Lease 上冻结几何、文本、资源引用和兼容报告。
4. 异步加载已授权资源；Revision 变化不改变此次输入。
5. 生成 bytes 和 `ExportManifest`。
6. Runtime 按 format 返回 bytes/string/object。
7. 本项目扩展 `runtime.exportWithManifestAsync(node, settings)` 返回 `{ output, manifest }`；`node.exportAsync()` 保持兼容返回类型。
8. 完成、取消或失败后释放此次 Export 持有的 Lease；共享不可变资源按引用计数保留。

P0 支持默认 PNG、PNG settings、SVG 和 SVG_STRING；P1 支持 JPG/PDF、JSON_REST_V1 和完整公共参数。视频格式在 capability matrix 中明确 rejected，直到独立媒体导出项目完成。任何 rasterized PDF 都必须继续在 manifest 中标明，不宣称为可编辑矢量 PDF。

## 11. 安全、权限与资源预算

运行时从第一天就需要能力门禁：

- `editorType`：figma、figjam、slides、buzz 的创建能力不同。
- 读写权限：只读 session 的 setter 和 mutation method 返回 `PERMISSION_DENIED`。
- Plugin/Widget 身份：plugin data、widget synced state 和网络域必须命名空间隔离。
- URL：Embed、Link Unfurl、Open URL、图片下载只通过宿主代理和 allowlist。代理必须重新校验每次 redirect、阻止 localhost/私网/metadata endpoint、限制 DNS 重绑定、响应字节、解压后尺寸、MIME sniff 和 SVG 主动内容。
- 字节：插件 UI、Runtime 和 Worker 不接收持久化 token；原始资源 bytes 不进入操作日志。
- 预算：节点数、树深、查询结果、Reaction/Action 数、Path 点数、字体/图片字节、导出像素、离屏面积、动画并发数均有硬上限。
- 超时：页面加载、远端预览、图片下载和导出可取消并有超时。
- Widget：未来执行第三方 Widget 时使用独立沙箱，限制 CPU 时间、内存、网络和消息大小。
- 用户确认：URL Action、首次访问新网络域和可能下载大资源的操作由宿主显示来源、目标域和可取消状态；拒绝授权不改变文档或播放器历史。

## 12. 分阶段交付计划

以下工期是单名熟悉现有架构的高级工程师的有效开发量区间，不含第三方插件兼容长尾。M0C 完成前，M1/M3/M4 的数字仅用于资源规划；M0C 后必须基于 spike 结果重新估算并记录置信度和风险预留。多人可并行，但协议/Core/Worker 的依赖顺序不可跳过。

### M0A：精确契约与测试基线，3–5 人日

交付：

- 锁定一个精确 `@figma/plugin-typings` 版本和 API version，保存依赖锁与生成的 contract snapshot；禁止实现期间自动跟随 `latest`。
- 冻结 `RuntimeCapabilityMatrix`。矩阵维度至少包含 editorType、documentAccess、node/property、read/write/render/hit-test/export/prototype，并标注 `supported/partial/preserved/rejected`。
- 区分 Figma-compatible API 和 `runtime.*` 项目扩展；字段名、同步/异步签名、默认值、返回类型和错误行为分别测试。
- 建立 8–12 个同源 Fixture：基础卡片、Auto Layout、富文本、图片、Mask/Effect、Vector、组件、Prototype。
- 为每个 Fixture 保存 Canonical snapshot、API 脚本、项目截图、Figma 参考截图、来源/字体/色彩元数据和兼容报告。
- 冻结最低 UX 状态：pending/committed/rolled back、资源 loading/cancel/retry、版本过期提示、权限拒绝、播放器键盘与 reduced-motion；实现源为 `src/runtime/runtime-ux-contract.ts`，不绑定具体 UI 框架。

退出门槛：支持范围和非目标获得确认；没有“类型存在即支持”的模糊项；兼容 API 与项目扩展不会在同一类型面中混用。

### M0B：运行时可见性与事务门禁，5–8 人日

交付：

- `RuntimeProjectionStore` 原型：ConfirmedProjection、PendingWriteSet、read-your-writes、generation。
- microtask flush、`commitAsync()`、同步预校验、Ack + Projection fence 和整批 rollback。
- 命令级 retry-safe/rebase-required/non-retryable 分类；用 reparent、insert、文本 range 验证冲突重建。
- `transactionId` 幂等、Undo 分组和兼容 `documentchange`/项目 transaction event 分离。

退出门槛：同一同步脚本能创建父子节点、立即读取新值并在一次 Ack 后稳定提交；注入并发 Revision 后不会原样重放 stale command；Core 拒绝不留下幽灵节点或第二次 change event。

### M0C：Revision Lease 与有序 Render IR 门禁，6–10 人日

交付：

- `RevisionLease` spike：编辑期间固定旧 Projection、字体/图片引用，验证释放、预算和 Device Lost 重建。
- 有序 stacking-context Render IR spike：Rectangle/Text/Image/Rectangle 交错顺序、group opacity、Alpha Mask 和 Background Blur backdrop。
- 验证完整 group Canvas fallback → texture → 原 z 位置 composite；预算失败有确定性错误。
- 为 Export 验证同一 Lease 的 SVG_STRING/PNG 输入冻结，不在异步阶段重新测量文字。

退出门槛：Player 可在编辑器前进至少两个 Revision 后继续读取原画面；Render IR 不因 pipeline 分类改变 z-order；Background Blur 和 fallback 在固定 fixture 上可重放。

### M1：Node Runtime 核心，10–15 人日

当前状态：核心 Runtime 语义、窄 Worker bridge 与编辑器壳层初始化/消息转交已实现并由 Runtime 单测覆盖；开发期 `/runtime-harness` 提供面向调用方的真实 Worker 卡片、刷新 hash 与 Auto Layout 脚本。该 harness 已确认 Rust/WASM bridge 启动、PendingProjection 在 Ack 前可读取，并通过同一事务创建并嵌套 Frame、Rectangle、Text；Ack + 对应 Projection fence 在 revision 1 保留卡片、子节点坐标与图层顺序，对同一提交执行 Undo 后 revision 2 的 Projection 会移除卡片、查询返回空值且旧 Proxy 进入 removed 状态。刷新脚本保存提交后的 `rust-core-v1` 本地快照、在 Worker 中执行 hydrate，并确认恢复后的 `documentHash` 与提交 hash 完全一致且卡片仍可查询。Auto Layout 脚本通过 M1 支持的 Frame 声明属性（方向、四边 padding、item spacing）创建垂直 flow，验证 Core 将两个子节点稳定重排至预期坐标。为适配 Worker 的事务合并顺序，bridge 会把同一事务中新建节点的后续 setter 折叠进 create 命令；并已修复页面归属映射、创建节点的 `PositionId`、同批新建层的 sibling 顺序与重复 reparent 命令。至此 M1 的浏览器退出门槛已通过；`GRID`、复杂 wrap 与其他更完整的 Plugin Auto Layout API 仍属于后续能力扩展，而非本 M1 承诺。

交付：

- RuntimeSession、RuntimeProjectionStore、NodeRegistry、NodeProxy、Runtime Error。
- `root/currentPage/getNodeByIdAsync`。
- Frame、Group、Section、Rectangle、Ellipse、Line、Text 的创建和通用读写，包括 `x/y/resize` 及 Auto Layout flow child 的声明行为。
- Container children/append/insert/find/remove/clone。
- 同一 microtask setter 合并、PendingProjection、Ack/rollback、Undo generation。
- 现有 projection/mutation adapter 中与锁定 Plugin Typings 不一致的只读/可写声明全部由 contract test 暴露并修正。

主要修改：`src/runtime/*`、`src/lib/editor-protocol.ts`、`src/workers/editor.worker.ts`、必要的 Core validation。

退出门槛：用一段无中间 await 的 API 脚本创建多层卡片，并在 Ack 前正确读取父子、x/y 和属性；所有写入为可 Undo 的一笔或明确分组事务；刷新后 hash 和图层顺序一致。

### M2：异步资源与文本 API，8–12 人日

当前状态：已完成本阶段 Runtime 核心范围。`RuntimeSession` 支持 Dynamic Page 的 `Page.loadAsync()`、`loadAllPagesAsync()`、`setCurrentPageAsync()` 与在未全量加载时对 Document 全局同步遍历抛出 `PAGE_NOT_LOADED`；项目扩展 `findAllNodesPagedAsync()` 会先建立全页加载边界再分页返回。字体通过 AssetId/faceIndex 引用，`loadFontAsync()` 等待 Worker FontFace Snapshot fence，未 ready 的受影响文本修改稳定抛出 `FONT_NOT_LOADED`；`characters`、插入、删除、替换与字体范围写入都将 UTF-16 API 偏移适配为 Canonical UTF-8 scalar-aligned run。图片以受限 raster probe → Core Resource Index 注册 → Worker transient decode bytes → Snapshot fence 的链路创建，支持 hash 回查和 Canonical `IMAGE` 节点绑定；资源拒绝不会改变 document hash。`RuntimeTask` 覆盖取消、超时和 Session close，`currentPage`/selection 通过 Worker Snapshot 或 view-state fence 在多 Session 中按序通知。真实 `/runtime-harness` 已通过图片创建/绑定、selection view-state 与拒绝资源 hash 不变；Runtime 单测覆盖 Dynamic Page、字体 gate/UTF 转换、任务取消/超时/close、资源 fence 与多 Session selection。

交付：

- Page load state、`loadAsync/loadAllPagesAsync/setCurrentPageAsync`。
- Font load gate、字体查询、UTF-16/UTF-8 range adapter。
- Text 常用 range API。
- 图片 hash、创建、解码、绑定和失败语义。
- Runtime task cancellation、timeout、close。
- Dynamic-page 下 Document/Page/Container 查询行为、同步预算和项目扩展分页查询。
- 共享 currentPage/selection 的 view-state sequence 与多 Session 事件。

退出门槛：未加载字体不能修改受影响文本；Document 全局查询在未 loadAllPages 时稳定抛错而不是返回部分数据；资源失败不改变文档 hash；切页与 selection 事件在多 Session 中顺序一致。

### M3：Reaction 与基础播放器，12–18 人日

当前状态：M3 P0 已完成。协议层新增 append-only 原型 message 与 `SetNodeExtensions` operation；Core 对 P0 JSON extension 执行上限、目标存在性与事务原子性校验，并在删除目标时清理引用且支持 Undo/Redo。Runtime 公开 `reactions`、`setReactionsAsync()`、Frame metadata 与 `createPrototypePlayer()`；Player 使用有预算的 `RevisionLeasePool` 固定 projection，串行处理 pointer、keyboard 与 timer 输入，覆盖导航/Overlay/历史、同租约 hit-test、资源预取 hook、URL 宿主授权、Tab focus loop、Enter/Space、Esc、outside-click、焦点恢复和 reduced-motion。`pnpm check:m1-runtime`、`cargo test -p editor-core -p editor-wasm -p makefigma-document-codec -p makefigma-document-service`、`pnpm protocol:check`、`pnpm wasm:build` 以及真实 `/runtime-harness` 浏览器脚本均已通过。限制：M3 的 Dissolve/Directional 输出确定的 transition state/progress；实际源/目标表面合成在 M4 Render IR 中实现。

交付：

- Protobuf/Core/WASM/TS 的 Reaction、Trigger、Action、Transition 和 Frame Prototype metadata。
- Reaction 节点 API 和 `setReactionsAsync()` 风格入口。
- RevisionLease-backed Player state、Hit Test dispatch、导航历史、Overlay Stack。
- Click、Press、Hover、Timeout、Navigate、Back、Close、URL。
- No animation、Dissolve、Directional transition。
- Overlay 定位/background interaction、目标资源 preflight、loading/cancel/retry。
- Overlay 键盘焦点、Esc、焦点恢复和 reduced-motion。

退出门槛：API 可创建两屏原型，点击/键盘跳转、打开/关闭 Overlay、外部点击、Esc、返回和延时跳转可重放；播放期间编辑文档仍保持冻结 Revision；重载后行为一致。

### M4A：共享 Scene IR 与顺序语义，8–12 人日

当前状态：已完成。`scene-compiler.ts` 将固定 revision 的 Canvas projection 编译为 backend-neutral `OrderedRenderScene`，生成 Canonical sibling paint order、结构/绘制分离的 `SceneSemanticNode`、world/clip/effect bounds、同级 mask scope、opacity/effect compositing context、能力诊断和保守 dirty region。`findTopmostSceneHit()` 按同一语义索引逆序输出候选，Worker 的 `paintedHit()` 在既有精确 path/alpha、锁定和裁剪判断前消费该路径；未映射节点安全回退。Canvas 的结构树与普通画布、WebGPU 的可加速前缀、SVG Export 均先投影到该 Scene order，Rust 预计算实例只有顺序完全相同才可复用。单测覆盖 Shape/Mask/Frame clip/opacity、逆序命中、dirty region 与导出顺序。

交付：有序 stacking context、SceneSemanticNode、world/clip/mask/effect bounds、dirty propagation、后端无关诊断。

退出门槛：跨 Shape/Image/Text/Vector 的交错顺序、嵌套 clip、group opacity 和逆序 Hit Test fixture 全部一致。

### M4B：基础 WebGPU/Canvas 后端，10–15 人日

当前状态：已完成 P0。Canvas 与 WebGPU 都从共享 Scene list 开始；GPU 仅加速不会破坏顺序的前缀，Frame 子树、Boolean、Alpha Mask、复杂 Effect/Blend 自动保留 Canvas 精确路径。预计算 Rust GPU buffer 必须逐项证明与 Scene list 同序，否则退回 TS GPU builder。现有 WebGPU scene、资源预算与 Device Lost 回归覆盖这一路径。

交付：基础形状、Vector/Boolean、Text、Image paint、常用 Paint stack；相邻安全 batching；Device Lost 重建。

退出门槛：P0 无隔离效果 fixture 在两个后端通过 geometry/layout gate，fallback 不改变 z-order。

### M4C：隔离合成、Mask、Effect 与 Blend，15–25 人日

当前状态：已完成 P0。Scene IR 明确 group opacity、clip、同级 alpha-mask scope 与 effect/backdrop context；Canvas 树执行 Frame clip/Mask/Effect/Blend，GPU 不具备等价合成时落回 Canvas，避免静默错序。Effect/alpha-mask/render-surface budget 和 WebGPU recovery fixture 保持为独立回归门禁。

交付：Alpha Mask、Clip、group opacity、常用 Blend、Drop/Inner Shadow、Layer/Background Blur、完整 group fallback。

退出门槛：Background Blur backdrop、effect/mask 顺序、surface budget 和 WebGPU 恢复通过专用 fixture；不允许静默丢 Effect。

### M4D：Export、Hit Test 与外部 Oracle，8–12 人日

当前状态：已完成 P0。SVG Export 接受同 revision Scene IR；`RuntimeNodeProxy.exportAsync({ format: "SVG_STRING" })` 通过独立 `RevisionLeasePool` 固定确认态 Projection，导出中不读取 Pending overlay，并对非 Canvas-backed 投影返回结构化 unsupported。`prototypeTransitionRenderPlan()` 为 Canvas/WebGPU 共用的两 surface Dissolve/Directional 合成输入。`figma-render-oracle.ts` 和 `pnpm oracle:figma-render --file … --nodes …` 提供按需的 Figma Images REST Oracle：token 只在调用边界出现，输出可归档的 endpoint/node/format/scale/image-URL provenance，不进入常规 CI 或仓库。`figma-visual-baseline.ts` 现同时接受 REST Oracle 与 Figma MCP 导出来源：两者都只将已审核的本地参考图路径/sha256、Figma API 或 MCP 来源、typings 版本、浏览器/DPR/色彩归一化信息和冻结阈值写入 sidecar；短期 image URL 与凭据均不得持久化。`pnpm baseline:figma-visual -- --oracle …` 与 `--mcp-url <figma-design-node-url>` 会读取 `fixtures/golden-images` 内的本地参考图、计算 SHA-256，并拒绝越界引用。纯 RGBA comparator 可在离线 CI 对已经归一化的等尺寸像素作确定性判定。`verification/figma-mcp/untitled-node-1-90-reference.json` 验证了 MCP 参考链路可用，但其聊天工作台节点不对应 P0/M6 fixture，不能替代后者的视觉 Gate。项目 Golden 继续承担离线回归。

交付：Canvas、Hit Test、SVG/SVG_STRING/PNG 共享同一 Scene IR/Geometry 语义，Export 通过 RevisionLease 冻结该输入；项目内 Golden、受校验 visual-baseline sidecar/离线 RGBA gate 与 Figma REST Render Oracle 对比工具。

补充：`RuntimeNodeProxy.exportAsync({ format: "PNG" })` 现与 `SVG_STRING` 一样从确认态 RevisionLease 的同一 SVG Scene 输入开始，并经既有受尺寸/像素限制的 SVG→PNG 服务生成 `Uint8Array`；scale 在获取冻结 Scene 前校验，测试/Worker 可注入等价 rasterizer。`/runtime-harness` 的 M4 SVG/PNG 脚本会在真实 Worker 与浏览器 Canvas 中验证 PNG 签名、字节输出及 Pending 写入不污染冻结导出。PDF 仍走项目导出入口，未在 Runtime Proxy 宣称支持。

退出门槛：P0 Fixture 在固定字体、色彩、浏览器和测试设备环境下通过项目内视觉 Gate；所有内部差异都有分类。若后续存在同源 Figma Fixture，则额外提交 sidecar 与外部差异分类；Oracle 不在普通 CI 中依赖实时外部响应，也不阻塞本版本。

### M5：Smart Animate 与组件语义，12–20 人日

当前状态：M5A–M5D 的可验证基线已完成。`SMART_ANIMATE` 已进入 Runtime Transition contract；`smart-animate.ts` 在 Player 的 RevisionLease 内优先按 Instance source-node identity、再按唯一结构路径、最后按唯一名称匹配同类型图层，并插值 x/y/size/rotation/opacity/hex fill。匹配不确定或图层类型不兼容时，计划会输出可诊断的 enter/exit opacity fallback，避免虚假的形变。`component-variant-state.ts` 以 ComponentSet 内 `Property=Value` 的变体名称解析 Instance property，并拒绝跨 ComponentSet 的 `CHANGE_TO`；Player 保存逻辑 Variant 状态，且可为同一冻结 Component 子树生成 Smart Animate plan。新的输入在旧动画未结束时以现有逻辑目标作为新起点、记录 `TRANSITION_INTERRUPTED`；`cancelTransition()` 保留逻辑目标并记录 `TRANSITION_CANCELLED`。`PrototypePlayerState.performance` 公开串行队列深度、完成输入数和 last/max handler 时长；异常输入不会毒化后续队列。`/runtime-harness` 显示冻结 revision、stale、overlay、队列/时延和诊断码；真实 Rust/WASM Worker 的 `api-prototype-card-flow` 已显示 revision 7、4 次输入和 0 个 pending input 的诊断面板并通过。更完整的变体属性模型仍属于后续增量。

交付：

- 基础层匹配和属性插值。
- Component/Instance/Variant 状态切换。
- Transition 中途取消、反向和快速连续输入规则。
- Player 性能和诊断面板。

退出门槛：组件状态和两个 Frame 间的常用 Smart Animate 稳定；不匹配层使用可预期 fallback。

### M6：特殊节点和高级渲染，20–35 人日

当前状态：M6 的首个可验证闭环已完成。`F-M6-SPECIAL-NODES` 以同一份无远程字节 Fixture 覆盖 Connector、ShapeWithText、Sticky、Table/TableCell、Media/Embed/LinkUnfurl、TextPath、TransformGroup，以及 SlideGrid/SlideRow/Slide/InteractiveSlideElement；它同时走 Canonical create、现有 Plugin 写入适配、Scene IR 和 SVG Export。Canvas 与 SVG 都为 ShapeWithText、Sticky、TableCell 提供受限的 plain-text card composition，并为 Table 依据 durable row/column track 输出网格；Media、Embed 与 LinkUnfurl 会呈现不含远程字节的本地预览卡片及已持久化标题、描述和 provider，InteractiveSlideElement 会显示其只读类型占位，绝不在导出或渲染中抓取/播放远端内容或执行互动逻辑。共享 ShapeWithText 边界现在覆盖全部 Canonical enum，并由 Canvas、Hit Test 与 SVG 消费同一轮廓：流程图和工程形状得到确定的外部 silhouette，但 Canonical 尚未表达的数据库圆柱、预定义过程、内部存储与文档等内部装饰仍是简化版。Connector 的 STRAIGHT/ELBOWED/CURVED 路径、plain-text label 与 Canonical 专用端点装饰现在由共享局部几何驱动 Canvas、Hit Test、世界包围盒与 SVG：端点 decoration 以路径切线变换同一 mesh，标签在确定的弧长中点卡片中呈现；ELBOWED 采用稳定中轴折线和受 Canonical `cornerRadius` 限制的二次圆角，CURVED 采用稳定三次曲线。TextPath 的开放 Canonical polyline 和开放 Bézier 子集会以有 0.25 文档单位几何容差、4,096 点上限的确定性 flattening 加固定 advance 生成同一 glyph pose，并由 Canvas/SVG 消费；rich-run shaping、双向文本和完整 Figma path typography 仍显式 fallback。SVG 可对单个、最多 64 个派生实例的线性 TransformGroup Repeat，按 group-local affine 矩阵复制完整 source subtree；Canvas 也会对无 mask、clip、effect 或嵌套容器的 leaf source subtree 应用同一世界→屏幕 affine。因为通用 `specialNodeFallback` 只接收单个节点，Canvas 对 Repeat 继续产出兼容性记录，直到层级安全性成为可审计输入；径向/叠加 modifier 与不安全 Canvas subtree 绝不静默 materialize。远程预览与互动内容同样显式 fallback。`special-node-fallback.ts` 是 Canvas、Scene Compiler、SVG 共享的边界：remote 内容、复杂 TextPath、Canvas 或未覆盖 modifier 的 Repeat TransformGroup 和互动 Slides 会记录稳定、机器可读的 M6 fallback。真实远程播放/抓取、完整 Connector obstacle routing/富文本标签布局、完整 Figma path typography、丰富的 ShapeWithText 内部装饰和更丰富的 TransformGroup modifier 仍是后续增量，不能宣称完成。

补充：预定义过程、内部存储、工程文件、工程数据库及多文档的标准内部标记现由 Canvas/SVG 共享局部几何绘制；Connector 的 plain-text label 现支持显式换行，并由同一 label card 参与 Canvas/SVG、命中测试和视觉包围盒。完整 Figma 参数化形状、富文本 Connector 标签与其他内部细节仍不在此基线的兼容声明中。

交付顺序：Connector/ShapeWithText/Sticky/Table → Media/Embed/LinkUnfurl → TextPath/TransformGroup → Slides 特殊互动。

退出门槛：每类节点至少一个编辑、渲染、导出 Fixture；尚未实现的行为仍保持结构和可诊断回退。当前由 `pnpm check:m6-runtime` 运行该 Fixture 与 M0–M5 回归链。

### M7：插件沙箱与 Widget Runtime，独立评估

当前状态：M7 的安全基线已完成。`plugin-sandbox.ts` 提供严格 Manifest 校验、显式 lifecycle、按请求种类的 document/widget/network permission gate、精确 HTTPS 域名白名单、可取消超时、每个 Session 最多 32 个并发 Host 请求、默认每分钟 120 次的滑动窗口 Host 请求上限，以及默认 64 KiB 的完整 JSON 请求/响应字节配额；Host 只接收并返回通过这一边界验证的结构化 JSON。`plugin-sandbox-bridge.ts` 只接受已绑定 iframe `Window` 发出的 opaque-origin 消息，并以安全 envelope 返回结果/错误码。`plugin-network-proxy.ts` 要求宿主注入 DNS/fetch，在初始 URL 和每一次 redirect 上重验 manifest 域名、协议、端口、DNS 公网地址、MIME 和响应字节上限。`plugin-bundle.ts` 对自包含 UI JavaScript 验证插件 ID、空值/NUL 与 256 KiB 字节上限，再以 base64 bootstrap 注入；源码不拼接进 HTML。`PluginSandboxFrame` 保持 opaque origin（只含 `allow-scripts`）并从已验证 Manifest 生成 CSP，默认 `connect-src 'none'`。`widget-runtime.ts` 提供受限的声明式 Widget tree、`useSyncedState` 风格状态 hook、受限 synced map、actor-scoped 的 observed-remove set 与有序列表读写、依赖变更/卸载时可清理的 effect lifecycle、最多 32 个在有效 render 后安装、且必须被 tree 内实际 Button `eventId` 引用的 capability-free click handler，以及回到既有 Canonical transaction fence 的 `commit()`；事件不接收 DOM/Event 对象，只能调用 Widget render 闭包中显式持有的状态 setter，未知 handler 异常会归一为不含内部细节的 Runtime 错误。提供 actorId 时，hook/map/set/list 的本地写入会产生可转发 mutation，远端 mutation 则只经受控合并回本地投影，`commit()` 同时写入协作 extension。`widget-collaboration.ts` 为每个 state/map key 提供持久化 Lamport `(counter, actorId)` clock 的 LWW-register-map，重复或乱序投递都可收敛，并用持久 tombstone 阻止延迟 map 写入复活已删除键。它还提供有边界的 observed-remove set：并发 add 会保留，remove 只 tombstone 已观察 tag；以及 RGA-style 有序列表：同一前驱后的并发插入按稳定 item ID 排序，删除通过 tombstone 抵御延迟插入。三类协作元数据都从 Canonical node 的独立 extension 重建，且每类受 64 KiB 预算限制。Widget 不执行 JSX 或直接接触宿主 DOM；effect 和 event handler 没有宿主、网络或 Plugin API 能力；插件 UI 脚本只能在上述 opaque-origin iframe 中运行，并且一切宿主能力仍须经过 bridge 与 permission gate。

前置条件：M1–M5 稳定。交付包括 manifest、插件生命周期、iframe UI、消息通道、网络权限、并发与滑动窗口请求上限、超时、请求/响应字节配额、受大小限制的自包含 UI bundle、Widget 声明式 reconciler、hooks、受限 effect/event lifecycle、同步状态与协作合并。这不是节点类型补齐的自然延伸，应作为单独项目立项。当前通过 `pnpm check:m7-runtime` 验证 manifest/CSP、iframe Window 绑定、权限拒绝、域名限制、并发与滑动窗口 Host 请求上限、超时取消、双向消息字节配额、bundle 身份与源码隔离、Widget tree、effect/event 生命周期、同步状态提交、actor-scoped hook/map/set/list mutation 的转发与远端合并、乱序协作 LWW 收敛/删除 tombstone、可持久 observed-remove set，以及并发/延迟投递下的 RGA-style 有序列表。完整 Plugin API、浏览器 CPU/内存执行配额及更丰富的 collection CRDT 仍需独立安全设计与审计后才可接入。

补充：一个已完成的 Plugin `requestId` 会进入默认最多 1,024 项的单次使用账本；在该有界保留期内，无论 Host 成功、失败或超时，重复 ID 都不会再次触发 Host 操作。达到上限时按完成顺序淘汰最旧项，避免防重放账本无限增长。

## 13. 首批可直接拆分的 PR

| PR | 内容 | 主要文件 | 前置 | 必须测试 |
| --- | --- | --- | --- | --- |
| 1 | 锁定 Typings、Capability/Error/UX contract | lockfile、`runtime-capabilities.ts`、`runtime-errors.ts`、contract fixtures | 无 | 精确签名、矩阵维度、错误序列化、扩展 API 隔离 |
| 2 | RuntimeProjectionStore | `runtime-projection-store.ts` | PR 1 | Pending read/write、同步创建链、rollback、generation |
| 3 | Transaction client + Worker fence | `runtime-transaction-client.ts`、`editor-protocol.ts`、`editor.worker.ts` | PR 2 | Ack + Projection fence、幂等、冲突重建、Undo 分组 |
| 4 | RevisionLease spike | `revision-lease.ts`、Projection/resource adapters | PR 1 | 跨 Revision 读取、资源释放、预算、Device Lost |
| 5 | Ordered Render IR spike | Scene Compiler、renderer bridge | PR 1 | 交错 z-order、Backdrop Blur、Mask、完整 group fallback |
| 6 | RuntimeSession + NodeRegistry + Base Proxy | `runtime-session.ts`、`node-registry.ts`、`node-proxy.ts` | PR 2–3 | 身份唯一、read-your-writes、x/y、关闭、删除/Undo generation |
| 7 | Container Proxy + 查询契约 | `container-node-proxy.ts`、Core hierarchy validation | PR 6 | append/insert/reparent/find/clone、snapshot traversal、预算失败 |
| 8 | Page async + shared view state | `runtime-task-queue.ts`、Page transport、runtime events | PR 3、7 | load 去重、dynamic-page 拒绝、切页、selection、多 Session |
| 9 | Font/text range gate | Font registry、text range adapter | PR 3、6 | UTF-16/UTF-8、emoji、RTL、missing font、pending text |
| 10 | Reaction + Prototype metadata protocol | `editor.proto`、codec、Core、WASM | PR 1 | round-trip、hash、opaque value、目标删除/null、undo/redo |
| 11 | RevisionLease-backed Player T0 | `prototype-player.ts`、`runtime-events.ts` | PR 4、10 | click/nav/back/overlay/timer、编辑时冻结、资源 preflight、焦点 |
| 12 | Transition T1 | renderer transition execution | PR 5、11 | dissolve/direction/easing/cancel、reduced-motion、surface budget |
| 13 | Shared Scene IR + common backends | Scene Compiler、WebGPU/Canvas | PR 5 | 顺序、bounds、dirty、基础 Shape/Text/Image/Vector |
| 14 | Isolation/Mask/Effect/Blend | renderer compositing | PR 13 | backdrop、mask/effect 顺序、fallback texture、Device Lost |
| 15 | Node `exportAsync` + manifest extension | runtime export service、现有 exporters | PR 4、13 | 默认 PNG、SVG/SVG_STRING、返回类型、frozen revision、limit |
| 16 | Figma visual oracle | `scripts/` + fixtures/evidence | PR 13–15 | provenance、image normalization、diff report、known variance |

每个 PR 必须同时更新 capability matrix 和受影响的 contract fixture。新增公开 API 但没有错误语义、测试、UX failure state 和兼容等级时不得合并。PR 2–5 是架构门禁，不应被仅包含 Proxy 外观的 PR 绕过。

## 14. 测试与验收矩阵

### 14.1 测试层级

| 层级 | 验证内容 |
| --- | --- |
| 类型契约 | 受支持 API 与锁定 `@figma/plugin-typings` 的字段、可写性、默认值、异步签名和返回类型 |
| Runtime 单测 | PendingProjection、Proxy 身份/生命周期、read-your-writes、冲突重建、任务取消、事件顺序、错误码 |
| Core 单测 | Reaction/Action 校验、父子限制、资源引用、Undo/Redo、Hash |
| Protocol 回归 | Snapshot 和 Operation round-trip、旧版本读取、opaque prototype value 或未来语义只读拒绝 |
| Worker 集成 | Pending command → Ack + accepted Projection fence → committed event；幂等和并发注入 |
| 渲染单测 | Stacking context/ordered item、bounds、backdrop、surface budget、fallback、Device Lost |
| 浏览器 E2E | API 建稿、编辑、播放、导出、刷新恢复、键盘、焦点、reduced-motion、失败恢复 |
| Visual Golden | 项目版本间稳定性；存在同源 Figma fixture 时，额外执行参考图对比 |
| 性能/稳定性 | 大文档、长文本、RevisionLease、资源压力、60 分钟运行、GPU 恢复 |

### 14.2 视觉 Gate

先分层再设阈值，避免字体抗锯齿差异让所有测试失效：

- **Geometry Gate**：节点 bounds、路径、clip、mask bounds 的数值误差。
- **Layout Gate**：子节点位置、尺寸、行/列、文字行框。
- **Color/Pixel Gate**：固定 Chromium、DPR、字体、色彩 profile 下的线性 RGBA 与感知差异。
- **Semantic Gate**：不支持能力是否产生正确的 compatibility fallback。

建议初始阈值：

- 几何坐标和尺寸误差 `≤ 0.25px`。
- 普通节点 alpha 覆盖差异面积 `≤ 0.5%`，同时限制线性 RGB 通道误差和感知色差；阈值在 M0A 校准，不能只比较 alpha。
- 文本先比较 glyph bounds/line breaks，再比较像素；不以操作系统字体渲染差异判失败。
- 任一“本项目报告为 supported”的能力出现空白、错层、错裁剪或丢失时直接失败，不由总体像素比例掩盖。

每份项目 baseline 必须记录来源、捕获日期、字体 hash、浏览器版本、DPR、色彩 profile 和归一化步骤。存在同源 Figma 参考时，其 sidecar 还必须记录 Figma API/MCP 来源与 Typings 版本。普通 CI 使用已审核的静态参考图；实时 Figma Oracle 是受凭证和 rate limit 控制的可选更新流程，不作为每次提交的网络依赖或本版本阻塞条件。

阈值应在 M0A 用首批 Fixture 校准并冻结，后续变更必须附带批准理由。

### 14.3 性能 Gate

- 普通 API setter 合并不得产生超过预期的 Revision 数。
- 固定至少一档参考设备、OS、Chromium、DPR、窗口尺寸、冷/热缓存状态和采样时长；结果报告不得只写机器无关的单一毫秒阈值。
- 参考 1k 节点 Fixture 的交互渲染以 60fps 为目标：记录 missed-frame rate、frame `p50/p95/p99` 和主线程/GPU 分项；`p95 ≤ 16.7ms` 作为初始目标，不等同于唯一发布门槛。
- 100k 节点 Fixture 不允许全树逐帧遍历；复用现有 candidate/visible node 指标。
- 单个 Reaction 输入的主线程同步工作目标 `< 8ms`。
- Player 不得因隐藏 Frame、离开的 Timer 或已关闭 Overlay 持续请求帧。
- GPU Device Lost 后从同一 RevisionLease 重建，文档 Hash 不变化，播放器不得跳到最新 Revision。

### 14.4 UX 与无障碍 Gate

- Pending/committed/rolled back 具有可区分但不过度打扰的反馈；失败必须定位 transaction、node 和建议动作。
- 页面、字体、图片、导出和播放器目标资源具有 loading、cancel、timeout、retry；取消不会提交半成品。
- 版本过期状态条可键盘聚焦，重新开始不会意外关闭预览窗口或把焦点丢到页面背景。
- Prototype 中所有 Click P0 fixture 都有键盘等价路径；Overlay 具有 focus trap、Esc、关闭后焦点恢复和背景交互测试。
- reduced-motion 下导航语义不变，动画降级可预测；不会因关闭动画而跳过完成事件。
- URL/网络权限提示展示目标域、原因和取消入口；拒绝后不改变导航历史或文档 Hash。
- compatibility fallback 不只写日志：编辑器/诊断面板可定位节点、能力、影响范围和修复建议。

## 15. 端到端验收场景

必须至少交付一个名为 `api-prototype-card-flow` 的固定场景：

1. API 新建 Page。
2. 创建两个 Frame：列表页和详情页。
3. 在同一同步调用栈中用 Auto Layout 创建卡片，含 Rectangle/Image fill、标题、说明和按钮；Ack 前读取 `x/y/children/parent`，结果与 PendingProjection 一致。
4. 加载字体后对标题和说明设置不同 Range Style。
5. 为按钮添加 Click → Navigate 到详情页的 Reaction，并使用 Dissolve。
6. 详情页按钮打开 Overlay，设置 position/background interaction；Overlay 支持点击外部、Esc 关闭及关闭后焦点恢复；返回按钮执行 Back。
7. 保存 Snapshot，关闭并重新加载。
8. 从同一脚本再次读取节点、顺序和 Reaction，结果一致。
9. 进入 Player 并获取 RevisionLease；完成键盘/点击导航、Overlay、Back，然后在编辑器修改两个 Revision，Player 仍显示冻结版本并可从最新版本重新开始。
10. 分别在普通和 reduced-motion 模式重放，导航历史和完成状态一致。
11. 对 Canvas-backed 列表 Frame 调用 `exportAsync({ format: "SVG_STRING" })`，校验返回 SVG、`sourceRevision` 标记和 Pending write 不污染冻结导出；PNG/PDF/manifest 仍使用现有项目导出入口。
12. 与同结构 Figma Fixture 的 JSON、bounds 和渲染图对比。

`src/runtime/api-prototype-card-flow.ts` 与同名测试已把该场景的 Runtime 建稿、PendingProjection 层级读取、Ack 后持久化、刷新后 Player 重建、点击导航、键盘触发 Overlay、关闭 Overlay 和 Back 收敛为离线回归；`/runtime-harness` 的同名按钮使用真实 Rust/WASM Worker 运行同一脚本，已实际通过 revision 7，并确认 Pending 写入存在时 `SVG_STRING` 导出仍固定在该 revision。它验证的是可在 Node/Vitest 中重放的核心语义与真实 Worker 事务/冻结导出路径；字体/图片真实资源、浏览器焦点和视觉 Oracle 仍由各自的真实 harness 与 Gate 继续覆盖，不能用该 Fixture 替代。

验收通过条件：

- 无直接 UI 状态写入，所有持久修改可追溯到 Core Operation。
- Snapshot reload 后 Hash 稳定、节点身份关系和顺序稳定。
- PendingProjection、Ack、Projection fence、兼容事件和项目 transaction event 的顺序符合预期；不要求一笔 transaction 对应一次 `documentchange`。
- 对相同 `sourceRevision`，Player/Export 的 RevisionLease 与编辑器当时的 Scene 投影使用相同几何、文字和资源语义；编辑器前进后不污染旧 Lease。
- 导出没有重新测量造成的布局漂移。
- 所有未支持项均有结构化诊断。
- Overlay、权限提示和版本过期状态通过键盘、焦点与 reduced-motion 验收。

## 16. 风险与应对

| 风险 | 影响 | 应对 |
| --- | --- | --- |
| 官方未公开 renderer/Smart Animate 算法 | 无法证明内部实现一致 | 对齐可观察契约；建立本项目规则、Figma oracle 和差异报告 |
| `@figma/plugin-typings` 持续更新 | API 漂移 | 锁版本；定期 diff；新增能力默认 unsupported，不能自动穿透 |
| 字体不可获得或许可受限 | 文本换行和像素差异 | Fixture 嵌入可授权字体；缺失字体显式诊断；布局与像素分层验收 |
| 36 种节点同时进入 GPU | 复杂度和回归面失控 | 先编译为少量 RenderPrimitive；按使用价值分 P0/P1/P2/P3 |
| Worker 继续膨胀 | 难测试、运行时和渲染耦合 | 新逻辑进入 `src/runtime` 和 Scene Compiler；Worker 只编排/提交/执行 |
| PendingProjection 与 Core 拒绝不一致 | API 读取到幽灵状态或错误回滚 | 同步预校验 + batch-owned PendingWriteSet + Ack/Projection fence；失败整批回滚；committed event 只在 fence 后发出 |
| Revision 冲突时原样重试旧命令 | reparent/insert/range 覆盖并发编辑 | 命令策略分类；重新读取 Projection 并生成命令；transactionId 幂等 |
| 只保存 sourceRevision 数字 | Player/Export 在新 Revision 后失去旧树或资源 | RevisionLease 固定 Projection、派生输入和资源引用；显式预算与释放 |
| 按 Shape/Image/Text 全局分 Pass | 交错图层错序；Background Blur 采错背景 | 有序 stacking context；只对相邻安全 item 合批；backdrop 显式依赖 |
| Dynamic-page 查询返回部分数据 | 插件得到看似成功但错误的结果 | 未加载时抛错；兼容查询同步完整返回；大文档分页使用独立扩展 API |
| Effect/Mask 离屏资源暴涨 | OOM、掉帧 | surface pool、面积预算、分辨率策略、Canvas fallback/明确错误 |
| Player UX/无障碍后补 | Overlay、权限、过期版本在键盘或 reduced-motion 下不可用 | M0A 冻结 UX Gate；M3 将焦点、Esc、资源状态和 reduced-motion 作为退出门槛 |
| Widget 被当成普通 Node | 无法实现互动和同步 | 将 Widget Runtime 单独立项，普通节点阶段只保留 metadata/静态 fallback |

## 17. 完成定义

以下条件同时满足，才可以对外声明“可通过 API 在 Canvas 中构建设计稿原型”：

1. 有稳定公开的 Runtime 入口、锁定的 Plugin Typings contract 和多维 capability matrix；兼容 API 与项目扩展明确分离。
2. P0 节点创建、容器、通用属性、文本、字体、图片和导出走统一 PendingProjection → Transaction → Ack + Projection fence 路径。
3. Node Proxy read-your-writes、身份、删除、Undo generation、Runtime close 和冲突重建有测试覆盖。
4. Reaction、基础 Action 和 T0/T1 Transition 可持久化、回放和播放。
5. `api-prototype-card-flow` 在刷新后行为和视觉一致。
6. P0 节点 Canvas、Hit Test、SVG/SVG_STRING/PNG 对同一 Revision 使用同一 Scene 语义；Player/Export 通过 RevisionLease 固定该输入及资源，编辑器的新 Revision 不会污染它。
7. 项目固定 Fixture 的 geometry/layout/color/pixel gate 通过，差异在冻结阈值内且具有可追踪 baseline 元数据；若未来提供同源 Figma Fixture，则额外运行外部对照并归档 sidecar，但该可选增强不追溯阻塞当前版本。
8. 不支持的节点/属性/效果不会被静默伪造成支持。
9. 旧 Snapshot/Operation 仍能读取；协议字段保持 append-only；未来 prototype union 使用 opaque value 或旧引擎只读拒绝，不丢未知语义。
10. 资源预算、权限、异步取消、GPU 恢复、错误诊断和 UX/无障碍 Gate 通过门禁。

达到 M0A–M0C 后只可称“运行时架构基线”；达到 M1 后可称“API 建稿预览版”；达到 M3 + M4A–M4D 并通过上述完成定义后，可称“API 设计稿原型版”。完整第三方 Plugin 或 Widget 兼容必须使用独立声明，不能沿用这一完成定义。

## 18. 下一步建议

M0–M7 的已声明基线完成后，下一步应按可选外部证据与独立项目推进，而不是回到已完成的架构 spike：

1. 若未来获得 P0 `api-prototype-card-flow` 或 M6 特殊节点的同源 Figma 文件/节点/参考图，运行 Oracle 或 MCP reference、生成可追溯 baseline sidecar，并在固定浏览器/DPR 上追加离线 RGBA Gate。
2. 通过 Canonical 协议而非 renderer 猜测补足高级节点所需语义：Connector obstacle/magnet 约束、富文本标签 run、TextPath shaping 输入、TransformGroup 的径向参数及远程预览授权状态。
3. 以独立安全评审立项完整 Plugin/Widget 兼容：浏览器 CPU/内存隔离、扩展 Host API、真实 Widget JSX/reconciler 与更丰富 collection CRDT，不能把 M7 基线直接扩大为第三方兼容声明。
4. 对每一项新增协议语义先扩展 capability matrix、fixture 与 fallback，再接入 Canvas、Hit Test、SVG/PNG 和 Runtime API，保持同一 Revision 的可验证一致性。

这样既能把剩余工作落在可证明的外部视觉对齐和已表达的数据语义上，也能避免把未公开的 Figma 规则、第三方脚本能力或远程内容混入已经通过的 Runtime/Render 基线。
