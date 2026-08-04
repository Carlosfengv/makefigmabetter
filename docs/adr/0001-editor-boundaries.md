# ADR 0001：编辑器运行时边界

状态：已采纳（Phase 0 基线）

## 决定

- Next.js App Router 和 React 只负责工具栏、图层树、属性面板、可访问语义和 Worker Proxy。
- Canvas 图层、文档状态、命中测试、视图状态、历史栈和每帧渲染只由一个 Engine Worker 持有。
- 当前 Worker 以辅助 `OffscreenCanvas` 承载最小 WebGPU Scene，并将其合成到主 `OffscreenCanvas` 的 Canvas 2D 网格/Text 覆盖层；后续以同一协议将该过渡实现替换为 Rust/WASM + `wgpu` WebGPU 后端。
- 编辑动作经由批量化 `EditorCommand` 协议进入 Worker；UI 不直接修改节点对象。
- Main Thread 对 Canvas Pointer Move 每帧只投递最新位置；Pointer Down/Up/Leave 不合并，并会在 Up/Leave 前同步 flush 最后一个 Move。Canvas 使用 Pointer Capture，拖出元素范围仍保留该顺序边界。Worker 只把 Hover 作为瞬态命中与描边渲染态，不能改变选择、历史、Snapshot 或持久化文档。
- Frame、Rectangle、Ellipse 与 Text 是一次性创建工具：工具栏、图层面板或快捷键选中后在画布完成一次创建，Worker 确认节点写入并选中该节点后，明确通知主线程切回 Move；避免下一次点击继续创建图层。
- 无 SharedArrayBuffer 的常规输入路径使用版本化、最大 256 条的可转移 `ArrayBuffer` 批次。主线程每帧聚合 Pointer Move/Wheel，相邻 Move 只保留最新位置；Down/Up 会与最后待发 Move 同批即时 flush。Worker 严格校验版本、长度、事件类型与有限数值后才派发。SAB 不是编辑正确性的前提，暂未启用为另一条输入协议。
- Main Thread 使用浏览器 `PerformanceObserver` 的 Long Task 条目作为瞬态健康证据。采样窗口在 Engine Worker 就绪后打开，衡量持续编辑而非页面启动成本；该计数仅在 UI 呈现，不写入 Worker、Journal 或 Document Snapshot。缺少该浏览器 API 时明确标示监测不可用，编辑功能不受影响。
- 平移、缩放、选择与框选通过不含节点或 Core Snapshot 的轻量 `view-state` 消息刷新 React 投影；视口操作停止 500ms 后才请求一次可持久化 checkpoint。高频临时交互不得逐帧序列化完整 WASM 文档或排入 OPFS/IndexedDB 写队列。
- IndexedDB 保存结构化 Journal 与 active/previous Manifest；不可变、带内容哈希的版本化 Rust Core Snapshot 先写入并校验 OPFS 后才会切换 Manifest，OPFS 不可用时使用内联 IndexedDB Snapshot 作为降级路径。v9 后新写入不再保存可编辑 presentation sidecar；它仅为旧快照迁移读取，不能作为第二份可写文档模型。支持 Web Locks 时，每份本地文档只有 Owner 写入；非 Owner 标签页只读、通过 BroadcastChannel 接收 Owner 已持久化的快照，并可用带优先级的编辑意图请求交接。没有 Web Locks 时仅降级为本地编辑，不能保证多标签页一致性。

## 后果

该边界避免 React 渲染频率绑定画布性能，也使后续把 TypeScript 原型替换为 Rust/WASM 时不改变 UI 的调用模型。现有 WebGPU Scene 仅覆盖基础实色图元，Canvas 2D 覆盖层不是完整 WebGPU 效果的兼容实现；它用于交互、真实 Device 生命周期与协议验证。
