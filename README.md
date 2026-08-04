# Makefigma Better

浏览器优先的类 Figma 设计编辑器原型。实现以文档中的「Phase 0 / Phase 1」为起点：画布不是 React DOM 图层，而是由单一 Engine Worker 持有和渲染。

## 当前可用范围

- Next.js App Router 编辑器壳：工具栏、图层树、属性面板与键盘操作；
- OffscreenCanvas + Engine Worker：无限网格、平移、光标锚定缩放、选中和拖动；主线程逐帧批量发送 Pointer Move/Wheel、合并相邻 Move，但不合并 Pointer Down/Up。无 SAB 时输入以有界、可转移 `ArrayBuffer` 批次交给 Worker，并以浏览器 Long Task API 提供瞬态响应性证据；
- Frame、Rectangle、Ellipse、Text 的创建与展示；
- Worker 侧 Undo/Redo、IndexedDB 操作 Journal、OPFS Core Snapshot 与本地恢复；
- 带 `transactionId` 与 `baseRevision` 的 UI → Worker 批量事务信封、结构化确认与 Rust 原子提交；
- Rust `editor-core` crate：稳定 `NodeId`、文档、版本检查、原子 Transaction 与 HistoryItem。
- 统一 CSP、COOP/COEP、CORP 与 Permissions-Policy 响应头：主页面处于 cross-origin isolated，仍保留无 SharedArrayBuffer 的完整编辑路径。
- Engine Worker 已有最小 WebGPU/WGSL Scene Renderer：它在辅助 OffscreenCanvas 绘制实色 Frame、Rectangle、Ellipse，再与主 Canvas 2D 的网格、Text 和渐变覆盖层合成；没有 WebGPU 或 Renderer 失败时完整回退到 Canvas 2D。Worker 会对一次 Device Lost 做有界恢复。它是验证真实 GPU 资源边界的过渡实现，不是最终 Rust `wgpu` Render Graph。
- Rust Core 已有有限 `f64` 的仿射变换、Bézier 展平、Bounds、填充/描边命中与轴对齐矩形 Boolean Spike；Canvas 命中测试会尊重旋转、椭圆和圆角。任意 Path Boolean、Clip/Mask 和空间索引仍在后续阶段。
- Rust Core 使用显式 `sRGB`、`Display P3`、`Linear sRGB` 的非预乘 Canonical Color 与 DocumentColorProfile；Snapshot schema v9、Operation/Document hash、旧 CSS 快照迁移、基础 2–16 stop LinearGradient，以及 Canonical rotation / fill、stroke Paint 与 stroke width 已固定语义。Canvas 2D 按确定性 P3→sRGB 回退并以受限线性样本显示填充及描边渐变；图片 ICC、其他渐变类型、导出与真实广色域渲染仍在后续阶段。
- Rust/WASM 已接管创建、重命名、几何更新、基础外观、基础 Text 内容、原子删除、这些语义事务的 Undo/Redo，以及版本化 Core Snapshot；文本进入 Canonical hash 和 Operation payload hash，Snapshot schema v3 持久化纯文本，同时可读取旧 v1/v2 快照。Canvas 2D 具备按显式换行、宽度与 Unicode 字素簇的基础文本换行和裁剪；它不是跨平台塑形或字体系统。WASM runtime 初始化会串行化 `init`/`hydrate` 并发，避免 stale linear memory。主线程会先追加已接受的 Core 操作 Journal，再把带内容哈希的不可变 Snapshot 写入并校验 OPFS，最后原子切换 IndexedDB 中的 active/previous Manifest 指针。OPFS 不可用时降级到 IndexedDB Snapshot；启动会回退并校验 previous Snapshot。Web Locks 会为同一文档选出唯一的本地写入标签页，其他标签页以只读副本运行，并通过 BroadcastChannel 接收持久化后的快照；Owner 关闭后 Follower 会自动重试并接管写入 Lease。浏览器会申请持久化存储并显示空间/清理风险。完整 Worker 崩溃恢复仍在迁移中。
- Main Thread 对 Engine Worker 的未处理异常执行一次有界重启，并优先从最近确认的 Core Snapshot 恢复；连续失败进入安全模式、停止接受编辑命令，避免恢复循环覆盖已确认状态。服务端 pending Operation、跨浏览器协调、诊断包和 GPU 资源重建仍在后续阶段。
- 解析后的本地事务会封装为带 schema、Document/Operation/Transaction/Actor ID、causal parents 与 SHA-256 payload hash 的 Operation Envelope；本地重复投递不会二次修改，篡改或复用 Operation ID 会被拒绝。网络 Protobuf、服务端认证注入和服务端 accepted revision 分配仍在后续阶段。
- Node 现保存 Canonical `PositionId`，WASM Snapshot schema v5 会持久化并按 parent/position/id 生成确定性顺序；旧 Snapshot 以 NodeId 派生默认位置迁移。图层拖拽、跨父级移动、服务端乱序转换与自动重平衡仍在后续阶段。
- `services/mock-backend` 是独立于 Next 的最小版本化契约服务，只提供健康与契约端点，证明 Web 与 Backend 可分别启动；它不包含认证、业务写入或 Document 状态。

这不是完整的 Figma 兼容实现。当前 Text 仅有 Canonical 纯文本内容；协同、WebGPU 渲染图、文本塑形/字体与富文本、Auto Layout、组件、Figma 导入与服务端仍是后续 Phase 的工作。

## 启动

```bash
pnpm dev
```

打开 `http://localhost:3000`。使用 `V` 选择、`H` 平移、`F` Frame、`R` 矩形、`O` 椭圆、`T` 文本；按 `⌘/Ctrl+Z` 撤销。

## 验证

```bash
pnpm build
pnpm lint
pnpm check:boundaries
pnpm check:compatibility
cargo test
```

Phase 0.11 的固定视觉 Fixture、Golden 采集约定和验收报告位于 `fixtures/` 与 `verification/phase0/0.11/`。本地启动编辑器后可运行：

```bash
bash scripts/capture-phase0-evidence.sh http://localhost:3000 output/phase0-evidence/local-run
```

画布角标会显示 Engine Worker 最近窗口的渲染 P95 与隐私安全诊断事件数量；这些瞬态采样不写入本地文档 Snapshot。

Core 最多接受 100,000 个节点及 256 MiB 的 Canonical Node 估算字节；Worker 会观测已分配 WASM linear memory 的 256 MiB 软阈值，并在设置 Canvas backing surface 前预检 DPR 后的 RGBA8 字节数（上限 512 MiB）。超限不会覆盖已有文档或表面。

开发时可打开 `/?fixture=phase0-basic-card&simulateGpuLoss=1`，在首次 WebGPU Scene ready 后触发一次真实 Device Lost 并验证有界恢复；传入 `=2` 可验证第二次丢失后稳定降级。该参数仅适用于固定 Fixture，生产构建会忽略它。

开发时可打开 `/?fixture=phase0-basic-card&simulateWorkerCrash=1`，在确认的 Core Snapshot 后触发一次 Worker 异常并验证恢复；传入 `=2` 可验证第二次连续异常后进入安全模式。该参数同样只适用于固定 Fixture，生产构建会忽略它。

Core 还提供服务端可调用的 tenant/document/editor AuthZ 契约，并为未来隔离资源解析提供 MIME、大小与危险 SVG 准入基线；本地浏览器原型本身不声明已经具备登录、服务端租户隔离或插件沙箱。

独立 Mock Backend 可单独启动或检查：

```bash
pnpm mock:backend
pnpm mock:backend:check
```

## 前端边界

`components.json` 固定 UI Primitive 配置；业务组件只能组合 `src/components/ui` 中的本地 Primitive。`pnpm check:boundaries`、ESLint 与[验证工作流](.github/workflows/verify.yml)会阻止 Pages Router、Next 业务 API、直接引入第三方 UI 基座及未经允许的 UI 依赖。

## 目录

```text
src/app/                 Next.js 路由与全局样式
src/components/editor/   编辑器 UI 组合层
src/components/ui/       本地 UI Primitive
src/workers/             单一 Engine Worker
src/lib/                 Worker 协议与本地持久化
crates/editor-core/      Rust Canonical Document / Command 基础
services/mock-backend/   独立 Mock Backend 及其版本化契约检查
docs/adr/                已冻结或待冻结的架构决策
```
