# Makefigma Better

[![Verify](https://github.com/Carlosfengv/makefigmabetter/actions/workflows/verify.yml/badge.svg)](https://github.com/Carlosfengv/makefigmabetter/actions/workflows/verify.yml)

一个浏览器优先的设计编辑器工程原型，用来验证类 Figma 产品最核心的技术边界：Worker 驱动的无限画布、Rust/WASM 文档内核、WebGPU 渲染、本地持久化，以及可演进的事务与恢复协议。

> 当前处于 **Phase 0**。项目已经具备可交互、可恢复、可验证的单机编辑闭环，但不是完整的 Figma 替代品，也不应直接作为生产协同编辑器使用。

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
- 图层树、属性面板、基础 Linear Gradient 和 Undo/Redo；
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
cargo test
```

GitHub Actions 会额外重新生成 WASM bridge，并验证前端、Rust Core、Mock Backend 和工程边界。

### WASM 重新构建

仓库已包含浏览器运行所需的 generated WASM 文件。修改 Rust/WASM bridge 后，需要安装对应工具并重新生成：

```bash
rustup target add wasm32-unknown-unknown
cargo install wasm-bindgen-cli --version 0.2.108 --locked
pnpm wasm:build
```

### Golden Evidence

固定 Fixture、Golden 与验收清单位于 `fixtures/` 和 `verification/phase0/`。启动本地编辑器后可以采集证据：

```bash
bash scripts/capture-phase0-evidence.sh \
  http://localhost:3000 \
  output/phase0-evidence/local-run
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

## 资源边界

| 资源 | 当前限制 |
| --- | ---: |
| Canonical Document 节点 | 100,000 |
| Canonical Node 估算内存 | 256 MiB |
| WASM linear memory 软阈值 | 256 MiB |
| Canvas backing surface | 512 MiB |
| WebGPU Scene 估算资源 | 256 MiB |
| Asset Probe 在途预算 | 128 MiB |

超限请求会在修改现有文档、渲染表面或资源状态前被拒绝。

## Mock Backend

`services/mock-backend` 是独立于 Next.js 的最小契约服务，用于证明 Web 与 Backend 可以分别启动。它只提供健康检查和版本化契约，不包含登录、业务写入或服务端 Document 状态。

```bash
pnpm mock:backend
pnpm mock:backend:check
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
services/mock-backend/   独立契约服务
fixtures/                固定文档与视觉 Golden
verification/            Phase 0 验收基线
docs/adr/                架构决策记录
```

## 明确边界

当前尚未实现：

- 多人实时协同、服务端 accepted revision、评论与正式权限系统；
- HarfBuzz/ICU4X/FreeType 字体栈、富文本、Caret、Selection 和 IME；
- Rust `wgpu` Render Graph、完整 GPU 资源重建、效果与图片渲染；
- Auto Layout、Constraints、Components 和 Variables；
- Figma 导入/写回与生产级导出；
- 任意 Path Boolean、Clip/Mask 和空间索引。

`.fig` 是私有格式，直接读写明确不在项目范围内。

## 文档

- [完整架构设计](figma-like-canvas-rust-wasm-webgpu-architecture.md)
- [兼容矩阵](docs/compatibility-matrix.md)
- [架构决策记录](docs/adr/)
- [CI 验证流程](.github/workflows/verify.yml)

## 路线图

- **Phase 0**：单机编辑闭环、Worker/WASM/WebGPU 边界、本地恢复与验证基线；
- **Phase 1**：完善渲染图、文本系统、资源管线与服务端 Operation 接入；
- **Phase 2**：Auto Layout、Constraints 和更完整的编辑语义；
- **Phase 3**：Components、Variables、导入与导出；
- **Phase 4**：多人协同、评论、权限与跨设备恢复。

这个仓库更关注正确的编辑器内核边界，而不是快速堆叠 UI 功能。每个新增能力都应同时定义数据语义、事务行为、恢复路径、资源预算和可验证证据。
