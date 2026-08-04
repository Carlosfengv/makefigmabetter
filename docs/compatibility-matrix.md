# 首版能力兼容矩阵

状态定义：`Supported` 已完成闭环；`Partial` 存在明确限制；`Later` 已规划但尚未实现；`Unsupported` 不在产品范围；`N/A` 表示该兼容维度不适用。`pnpm check:compatibility` 会校验每一行均有四个明确维度状态和当前限制说明。

| 能力 | Schema | 视觉 | 编辑行为 | Round-trip | 当前状态 |
| --- | --- | --- | --- | --- | --- |
| Document / Page / SceneNode 层级 | Partial | N/A | Partial | Partial | Core 已保存稳定 NodeId、parent_id 与 Canonical PositionId，但浏览器投影仍是单页扁平列表；完整 Document/Page Schema、引用校验、迁移与多页面 round-trip 在 Phase 1 完成，Section/Group/Line 和嵌套图层编辑在 Phase 2 完成 |
| Frame / Rectangle / Ellipse / Text | Partial | Partial | Partial | Partial | 基础单机原型；rotation、stroke 与 stroke width 已进入 Core Snapshot v9、Operation hash 与 Undo/Redo；当前节点尚未形成完整的容器嵌套编辑闭环 |
| Text 内容与排版 | Partial | Partial | Partial | Partial | Rust Core `SetText`、Undo/Redo、Operation hash 与 Snapshot schema v3 已覆盖基础纯文本；Canvas 过渡布局器保护字素簇、基础换行和基于首个 Unicode 强字符的 LTR/RTL 段落方向，浏览器负责当前 glyph shaping。Phase 1 完成 HarfBuzz/ICU4X/FreeType、完整 Unicode Bidi/断行、富文本 run、字体加载、Caret/Selection、IME 与 Glyph Atlas；Phase 2 完成高级段落与多选样式编辑体验 |
| 无限画布、平移与缩放 | N/A | Partial | Partial | N/A | 基础单机原型 |
| 变换、基础命中与几何数值 | Partial | Partial | Partial | N/A | Rust f64 仿射/Bezier/Bounds/Fill/Stroke Spike；Canvas 投影支持旋转、椭圆、圆角命中，Worker Spatial Grid 已用于候选查询与视口裁剪；任意 Path Boolean、Clip/Mask、深层选择、生产级 R-tree/BVH，以及八方向和多选 Transform 在 Phase 2 完成 |
| 命令、Operation、幂等与 Undo/Redo | Partial | N/A | Partial | Partial | Rust 语义 HistoryItem、transactionId 与 operationId 幂等、Envelope payload SHA-256、PositionId Canonical 排序、确定性本地回放与 Worker 投影已完成。Phase 1 增加 Protobuf、服务端 AuthZ/accepted revision、持久 pending 队列、断线重试与单客户端对账；多人并发合并和协同 Undo 属于 Phase 4 |
| 本地快照恢复与多标签页 | Partial | Partial | Partial | Partial | OPFS Core Snapshot + IndexedDB Journal/Manifest 回退；支持 Web Locks 时以单写者与带优先级的 BroadcastChannel 交接保证唯一 Owner，刷新同步释放 Lease；没有 Web Locks 时保留本地编辑但不保证多标签一致性。未处理 Engine Worker 异常可从最近确认快照有界重启，连续失败进入安全模式；服务端 pending Operation Ack 在 Phase 1 完成，跨浏览器多人协调属于 Phase 4 |
| WebGPU / WebGL2 | Partial | Partial | N/A | N/A | Worker 使用辅助 OffscreenCanvas 的实际 WebGPU/WGSL Scene Renderer 绘制实色 Frame/Rectangle/Ellipse，并合成至 Canvas 2D 的网格、Text 与渐变覆盖层；Device Lost 最多恢复一次。Phase 1 完成 Rust `wgpu` Render Graph、基础图片/文本 Pass、GPU 资源管理和完整重建；高级 Mask/Blur/Blend Effect 在 Phase 2 完成 |
| 色彩空间、alpha 与渐变插值 | Partial | Partial | Partial | Partial | Rust Core 已固定 sRGB / Display P3 / Linear sRGB、非预乘存储、DocumentColorProfile，以及带 2–16 个显式色彩 stop 的 Canonical LinearGradient；Snapshot v9 保留 `colorProfile`/`fillColor`/`fillGradient`/`strokeColor`/`strokeGradient`/`rotation`/`stroke`/`strokeWidth` 并迁移旧 CSS Fill 与 sidecar appearance。Canvas 2D 以与 Core 相同的 P3→sRGB 回退和每区间 64 个线性 sRGB 样本近似绘制填充及描边，WebGPU 过渡层把渐变 Paint 留给 Canvas 覆盖层；Canvas 2D 广色域、其他渐变类型、图片 ICC 与导出后续完成 |
| Golden、性能采样与诊断证据 | Partial | Partial | Partial | N/A | 固定 F-PHASE0-BASIC-CARD Fixture、受限 Worker 诊断日志、滚动 P50/P95/最大值采样和验收模板已就绪；首张 Canvas 2D / 1440×960 / DPR 1 的经审核 PNG Golden 已冻结，后续采集按 SHA-256 严格比对 |
| 文档、Undo/Operation 与渲染表面预算 | Partial | N/A | Partial | N/A | 100,000 节点与 256 MiB Canonical Node 估算准入、已分配 WASM linear memory 的 256 MiB 软诊断、Core 历史/去重预算、512 MiB Canvas backing surface 预检已实现；Asset Probe 还以 128 MiB 在途总量预算限制并发探测，完成/取消会释放预留。实际 WebGPU Scene 在配置前也估算三张 RGBA8 swap-chain 表面和顶点缓冲，以 256 MiB 硬上限回退 Canvas 而不改 Document，并显示瞬态资源指标。Phase 1 完成真实 GPU Render Graph 资源、Asset 解码和完整 OOM 取消 |
| 对象级 AuthZ 与不可信资源 | Partial | N/A | Partial | N/A | Core AuthZ Contract Harness 覆盖 tenant/document/editor/actor 注入并产生 v1 脱敏授权审计事件；独立 Asset Probe Worker 对 SVG、PNG/JPEG/WebP 与 WOFF/WOFF2/TTF/OTF 做有界 MIME/头信息识别，并为接受、拒绝或取消生成 v1 脱敏事件。SVG 限于静态、同文档 `#fragment` 引用子集，并在 DOM 前拒绝脚本、样式、动画、DTD/Entity、data/远程 URL；Raster 在解码前限制尺寸和 RGBA8 预算。Phase 1 完成服务端对象级 AuthZ、AssetId/contentHash、隔离解码、缓存、受控上传和审计投递；真实插件权限模型后续完成 |
| 完整编辑语义与可访问 UI | Later | Later | Later | Later | Section、Group、Line、嵌套图层树、跨父级排序、八方向与多选 Transform、Shadow、Mixed Inspector、Menu/Dialog/Tooltip/Toast 和完整键盘/屏幕阅读器流程统一归入 Phase 2 |
| 前端目录、UI Primitive 与构建边界 | Partial | N/A | Partial | N/A | App Router、`components.json`、`components/ui`、ESLint 导入限制、依赖 allowlist、Rust 工具链锁定与 CI 已就绪；`services/mock-backend` 已作为独立进程及版本化契约检查存在，Phase 1 建立可独立构建、部署和回滚的 Rust Document/Asset Backend |
| Auto Layout、Constraints | Later | Later | Later | Later | Phase 2 |
| Components、Variables、Figma 导入/写回 | Later | Later | Later | Later | Phase 3 |
| 多人协同、评论、权限 | Later | N/A | Later | N/A | Phase 4 |
| `.fig` 私有文件读写 | Unsupported | Unsupported | Unsupported | Unsupported | 明确非目标 |
