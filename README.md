# Makefigma Better

[![Verify](https://github.com/Carlosfengv/makefigmabetter/actions/workflows/verify.yml/badge.svg)](https://github.com/Carlosfengv/makefigmabetter/actions/workflows/verify.yml)

一个浏览器优先的设计编辑器工程原型，用来验证类 Figma 产品最核心的技术边界：Worker 驱动的无限画布、Rust/WASM 文档内核、WebGPU 渲染、本地持久化，以及可演进的事务与恢复协议。

> **Phase 0 已于 2026-08-04 完成，项目当前进入 Phase 1。** 项目已经具备可交互、可恢复、可自动验证的单机编辑闭环；下一阶段将补齐 Document/Page、服务端 Operation、资源、文本与渲染内核。它不是完整的 Figma 替代品，也不应直接作为生产协同编辑器使用。

## 为什么做这个项目

大型设计编辑器不能把文档模型和逐帧画布更新绑定在 React 渲染周期上。Makefigma Better 从一开始就明确运行时边界：

```text
React / Next.js UI
        │  Transaction + transferable input batch
        ▼
Single Engine Worker ───── WebGPU / Canvas 2D
        │
        ▼
Rust / WASM Canonical Document Core
        │
        ├── IndexedDB Journal
        └── OPFS immutable Snapshot
```

- React 负责工具栏、图层、属性面板和可访问语义；
- Engine Worker 独占画布、视口、选择、命中测试和逐帧渲染；
- Rust Core 是文档语义、revision、Undo/Redo 和 canonical hash 的权威来源；
- IndexedDB、OPFS、Web Locks 与 BroadcastChannel 构成本地恢复和多标签页基础设施。

## Phase 0 能力

### 编辑体验

- Frame、Rectangle、Ellipse、Text 的创建、选择、拖动、复制和删除；
- 无限网格、平移、光标锚定缩放、旋转与基础命中测试；
- 基础图层列表、属性面板、基础 Linear Gradient 和 Undo/Redo；
- 基础纯文本换行、字素簇保护和 LTR/RTL 段落方向；
- UI Transaction 单飞排队、revision 冲突处理和未确认输入的乐观投影。

### 渲染与性能

- `OffscreenCanvas` 上的单一 Engine Worker；
- 可转移 `ArrayBuffer` 输入批次，合并高频 Pointer Move/Wheel，同时保留 Down/Up 顺序边界；
- 最小 WebGPU/WGSL Scene Renderer，并与 Canvas 2D Text、网格和渐变覆盖层合成；
- WebGPU 不可用或 Device Lost 恢复耗尽时回退 Canvas 2D；
- 高频选择和视口更新使用轻量 `view-state`，停止操作后再生成持久化 checkpoint；
- Worker 渲染 P50/P95、主线程 Long Task 和资源预算指标。

### 文档内核

- Rust `editor-core`：稳定 Node ID、原子 Transaction、HistoryItem 和版本检查；
- 带 Transaction ID、Operation ID、Actor ID、causal parents 与 SHA-256 payload hash 的 Operation Envelope；
- Canonical `PositionId`、Document hash、Operation hash 和删除 ID tombstone；
- sRGB、Display P3、Linear sRGB、非预乘 alpha 与 2–16 stop Linear Gradient；
- 版本化 WASM Snapshot、旧 schema 迁移与确定性回放。

### 本地可靠性

- IndexedDB Operation Journal；
- OPFS 不可变 Core Snapshot，以及 active/previous Manifest 回退；
- OPFS 不可用时降级到 IndexedDB Snapshot；
- Web Locks 单写者和 BroadcastChannel 多标签页同步；
- 新编辑标签页可通过带优先级的意图请求接管写入，原 Owner 转为只读；
- 浏览器缺少 Web Locks 时允许本地编辑，但不保证多标签一致性；
- Engine Worker 一次有界重启，连续失败后进入安全模式。

## 快速开始

### 环境要求

- Node.js 22+
- pnpm 11.8（版本已固定在 `package.json`）
- 支持 OffscreenCanvas 的现代浏览器

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm dev
```

打开 [http://localhost:3000](http://localhost:3000)。

### 快捷键

| 操作 | 快捷键 |
| --- | --- |
| 选择 / 移动 | `V` |
| 平移画布 | `H` |
| 创建 Frame | `F` |
| 创建 Rectangle | `R` |
| 创建 Ellipse | `O` |
| 创建 Text | `T` |
| 撤销 | `⌘/Ctrl + Z` |
| 重做 | `⌘/Ctrl + Shift + Z` |
| 复制 | `⌘/Ctrl + D` |
| 删除 | `Backspace` |

## 验证

提交前建议运行完整验证集：

```bash
pnpm test
pnpm lint
pnpm build
pnpm check:boundaries
pnpm check:compatibility
pnpm mock:backend:check
pnpm document:api:check
pnpm protocol:check
cargo test
```

原生 Rust `wgpu` MainScene executor 是 Phase 1 的可选编译特性；它不进入浏览器 WASM 包，也不持有 Canonical Document：

```bash
cargo test -p makefigma-renderer-wgpu --features native-wgpu-executor
```

GitHub Actions 会额外重新生成 WASM bridge，并验证前端、Rust Core、Mock Backend 和工程边界。

### WASM 重新构建

仓库已包含浏览器运行所需的 generated WASM 文件。修改 Rust/WASM bridge 后，需要安装对应工具并重新生成：

```bash
rustup target add wasm32-unknown-unknown
cargo install wasm-bindgen-cli --version 0.2.126 --locked
pnpm wasm:build
```

### Golden Evidence

固定 Fixture、Golden 与验收清单位于 `fixtures/` 和 `verification/phase0/`。启动本地编辑器后可以采集证据：

```bash
bash scripts/capture-phase0-evidence.sh \
  http://localhost:3000 \
  output/phase0-evidence/local-run
```

采集器默认先预热 30 秒，再执行 3 轮受控渲染采样（每轮 240 个样本），并将中位 P50/P95/最大值写入 `performance-summary.json` 和验收报告。固定 Fixture 的截图会保持性能文字稳定，性能原始值仍会作为证据保存，因此瞬态指标不会造成 Golden 误报。

Phase 1 的图片/形状/文字组合输入可通过以下命令确认；它固定验证图片字节哈希、PNG IHDR CRC、尺寸与场景组成，浏览器入口为 `/?fixture=phase1-render-composite`。跨环境图片 Golden 仍需独立人工审核后冻结。

```bash
pnpm check:phase1-render-composite-fixture
```

```bash
pnpm evidence:phase1-render-composite \
  http://127.0.0.1:3000 \
  output/phase1-render-composite/local-run
```

同一夹具的工具栏创建、画布拖拽创建、Undo/Redo 可用以下命令复核：

```bash
pnpm evidence:phase1-editing \
  http://127.0.0.1:3000 \
  output/phase1-editing/local-run
```

## 故障注入

以下参数只在开发环境和固定 Fixture 下生效：

```text
/?fixture=phase0-basic-card&simulateGpuLoss=1
/?fixture=phase0-basic-card&simulateGpuLoss=2
/?fixture=phase0-basic-card&simulateWorkerCrash=1
/?fixture=phase0-basic-card&simulateWorkerCrash=2
```

- 第一次 GPU Device Lost 会触发一次有界恢复；第二次会稳定降级；
- 第一次 Worker Crash 会从最近确认的 Core Snapshot 恢复；连续失败会进入安全模式。

可运行以下命令，采集两条 GPU 恢复路径的状态与控制台证据：

```bash
bash scripts/capture-phase1-gpu-recovery-evidence.sh \
  http://127.0.0.1:3000 \
  output/phase1-gpu-recovery/local-run
```

## 资源边界

| 资源 | 当前限制 |
| --- | ---: |
| Canonical Document 节点 | 100,000 |
| Canonical Node 估算内存 | 256 MiB |
| WASM linear memory 软阈值 | 256 MiB |
| Canvas backing surface | 512 MiB |
| WebGPU Scene 估算资源 | 256 MiB |
| Asset Probe 在途预算 | 256 MiB |

超限请求会在修改现有文档、渲染表面或资源状态前被拒绝。

## Mock Backend

`services/mock-backend` 是独立于 Next.js 的最小契约服务，用于证明 Web 与 Backend 可以分别启动。它只提供健康检查和版本化契约，不包含登录、业务写入或服务端 Document 状态。

```bash
pnpm mock:backend
pnpm mock:backend:check
```

## 本地 Document API

Phase 1 的 Rust Document API 与 Next.js 独立启动，默认仅绑定在回环地址 `127.0.0.1:8788`。它接收原始 Protobuf `OperationEnvelope`，并返回 Protobuf `OperationAck` 或 `ProtocolError`；SQLite 状态写入被忽略的 `.local/` 目录。

```bash
pnpm document:api
curl http://127.0.0.1:8788/health
```

本地开发身份通过两个明确的 `x-makefigma-dev-*` 请求头模拟；它只用于开发环境，生产认证适配器必须在服务端从会话注入 Tenant/Actor，不能信任浏览器 Header 或 Envelope 字段。

## 本地 Asset API

Phase 1 的资源服务独立绑定在 `127.0.0.1:8789`，支持带服务端确认 offset 的分段上传、完成时 SHA-256/MIME 校验与租户内去重，以及文档 Writer/Reader 授权下的短期下载凭据。它同样只使用本地开发身份头，SQLite 状态保存在忽略的 `.local/` 目录。

```bash
pnpm asset:api
curl http://127.0.0.1:8789/health
```

## 项目结构

```text
src/app/                 Next.js App Router 与全局样式
src/components/editor/   编辑器 UI 组合层
src/components/ui/       本地 UI Primitive
src/workers/             Engine Worker 与 Asset Probe Worker
src/lib/                 协议、渲染、输入、恢复与持久化模块
src/wasm/generated/      wasm-bindgen 浏览器产物
crates/editor-core/      Canonical Document Core
crates/editor-wasm/      Rust Core 的 WASM bridge
crates/protocol/         从 schemas/proto 生成的 Rust 服务端契约
crates/document-service/ SQLite 事务、AuthZ 与 Operation accepted revision 服务基础
crates/asset-service/    受控上传、Hash 去重与文档级下载授权服务基础
services/document-api/   独立 Rust Protobuf HTTP 适配层（默认 loopback）
schemas/proto/           Operation、Snapshot、Ack 与版本协商 Schema
packages/protocol-types/ 从同一 Schema 生成的 TypeScript 契约
services/mock-backend/   独立契约服务
fixtures/                固定文档与视觉 Golden
verification/            Phase 0 验收基线
docs/adr/                架构决策记录
```

## 明确边界

当前尚未实现：

- Section、Group、Line 和嵌套图层编辑；
- HarfBuzz/ICU4X/FreeType 字体栈、富文本、Caret、Selection 和 IME；
- Rust `wgpu` Render Graph、完整 GPU 资源重建、效果与图片渲染；
- 字体节点级 Asset 引用、完整隔离解码、客户端缓存和对象存储部署闭环（图片导入、受控上传、Document 附加、Resource Index 注册、选中图层的图片填充 / 无选择时新建 Image 节点与刷新恢复已落地）；
- Auto Layout、Constraints、Components 和 Variables；
- Figma 导入/写回与生产级导出；
- 任意 Path Boolean、Clip/Mask、深层选择和生产级 R-tree/BVH 空间索引；
- 多人实时协同、Presence、评论与正式权限系统。

`.fig` 是私有格式，直接读写明确不在项目范围内。

## 文档

- [完整架构设计](figma-like-canvas-rust-wasm-webgpu-architecture.md)
- [兼容矩阵](docs/compatibility-matrix.md)
- [架构决策记录](docs/adr/)
- [Phase 0 完成记录](verification/phase0/completion.md)
- [CI 验证流程](.github/workflows/verify.yml)

## 路线图

- **Phase 0（已完成，2026-08-04）**：冻结单机编辑闭环、Worker/WASM/WebGPU 边界、本地恢复与验证基线；
- **Phase 1**：补齐 Document/Page 层级语义，建立 Protobuf 契约和单客户端服务端 Operation 闭环，完成图片/字体资源管线、正式文本引擎与 Rust/wgpu Render Graph；
- **Phase 2**：实现 Section、Group、Line、嵌套图层树、八方向与多选 Transform、跨父级排序、Shadow、Mixed Inspector、完整键盘可访问性，以及 Vector、Effect、Auto Layout、Constraints 和导出；
- **Phase 3**：Components、Variables、Figma 导入与写回；
- **Phase 4**：在 Phase 1 的服务端 Operation 基础上实现多人协同、Presence、评论、权限与跨设备恢复。

Phase 1 的服务端接入只要求单客户端从本地提交、持久 pending、获得 accepted revision、断线重试并完成对账；多人并发合并、远端 Presence 和协同 Undo 仍属于 Phase 4。Phase 2 的编辑语义不得反向改变 Phase 1 已冻结的稳定 ID、父子顺序、Operation、Asset 和文本版本契约。

这个仓库更关注正确的编辑器内核边界，而不是快速堆叠 UI 功能。每个新增能力都应同时定义数据语义、事务行为、恢复路径、资源预算和可验证证据。
