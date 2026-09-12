# Phase 2 P1-3 验收记录：源码冻结后重采 Golden 与性能 Gate

- 日期：2026-08-07
- 计划条目：`docs/phase2-remediation-plan.md` P1-3
- 状态：源码冻结后的**新候选已采集且三项性能 Gate 全过**；**独立审核者冻结 baseline 仍待办**（候选 `golden.status = pending-independent-review`，`requiresReviewerFreeze: true`）。

## 冻结前提（全部满足）

- P1-1 Stroke 单一几何来源收口已完成，源码进入冻结点。
- 重建 WASM 桥接 `bash scripts/build-wasm.sh`（wasm-bindgen 0.2.126），`src/wasm/generated/*` 与当前 Core 源码一致。
- `MAKEFIGMA_NEXT_DIST_DIR=.next-evidence pnpm build` 生产构建通过；路由表已**不含** `/api/workspaces`（印证 P1-6 迁移，前端无业务 Route Handler）。
- P3-1 已消除 `rg` 依赖，采集脚本 readiness 轮询用 `grep`；本机 Playwright CLI 可用。

## 采集环境

- HeadlessChrome 151，视口 1440×960，DPR 1，WebGPU 可用，hardwareConcurrency 10。
- 生产 `next start`（`.next-evidence`）监听 `http://localhost:3013`，`?fixture=phase2-common-nodes` 固定 Fixture。
- Fixture SHA-256 `1aa99d33…92417`、manifest SHA-256 `a1821c8d…b11fb`（与 `verification/phase2/common-nodes-fixture-manifest.json` 一致）。

## Golden / 性能候选（已完成）

- 目录 `output/phase2-common-nodes/20260807T030452Z/`（`makefigma-phase2-common-nodes-evidence-v1`，`capturedAt 2026-08-07T03:05:59Z`）。
- console **0 error**（`console.txt`：`Errors: 0, Warnings: 0`）。
- 3 次性能采样（每次 64 次交替 pan，5s 预热），中位数：
  - Render P95 **1.61 ms**（阈值 < 12）
  - Input-to-render P95 **19 ms**（阈值 < 50）
  - Input backlog P95 **16.95 ms**（阈值 < 32）
  - `gates`: `renderP95Under12Ms / inputToRenderP95Under50Ms / inputBacklogP95Under32Ms` 全 `true`。
- 性能摘要 `performance-summary.json`（`status: local-candidate`），产物均带 SHA-256。
- `golden.status = pending-independent-review`，`candidatePolicy`: rgba 像素比对，maxChannelDelta 2，maxDiffPixelRatio 0.005，`requiresReviewerFreeze: true`。

## 稳定性候选（已完成）

- 目录 `output/phase2-common-nodes/stability-20260807T030820Z/`，`MAKEFIGMA_PHASE2_STABILITY_DURATION_SECONDS=3600`（实测 3,600 秒、15s 周期、**146 个周期**，每周期 64 次交替 pan）。
- console **0 error**（`console.txt`：`Errors: 0, Warnings: 0`）；采集前后各一张截图（`phase2-common-nodes-start.png` / `-end.png`）。
- 146 次采样中位数（`performance-summary.json`，`status: local-candidate`，`gates` 全 `true`）：
  - Render P95 **2.1 ms**（阈值 < 12）
  - Input-to-render P95 **24 ms**（阈值 < 50）
  - Input backlog P95 **17.745 ms**（阈值 < 32）
- 结论：60 分钟连续负载下三项 Gate 持续满足，无渲染/输入退化、无 console 错误。

## 旧候选失效说明

- 计划记载的 `output/phase2-common-nodes/20260806T041922Z/` 与 `stability-20260806T014459Z/` 等均在 Stroke 网格改动前采集，按 preflight 自身规则已失效；本轮以冻结源码重采取代。

## 待办（计入 Gate 前）

- 独立审核者比对本轮 Golden 截图与像素策略、复核两份 `performance-summary.json` 的三项 Gate、确认 console 0 error，签署并把 `golden.status` / `signOff` 从 `pending-independent-review` 冻结为 baseline；签署记录归档本目录。此步骤按计划属独立审核环节，与 P1-2 的 AT 复核同批，不能由采集执行者自签。

## 2026-08-16 R0 修复后复采

- 候选目录：`output/phase2-common-nodes/r0-r2-20260816/`。
- 环境：HeadlessChrome 151、1440×960、DPR 1、WebGPU 可用。
- fixture SHA-256：`0d1e79460a7e9d56b4dac0d56ef22e3d61a323fa6f1d5b3b70978c5d62eb4428`；console 为 `Errors: 0`。
- 三轮中位数：Render P95 **1.345 ms**、Input-to-render P95 **2 ms**、Input backlog P95 **0.05 ms**；三项自动 Gate 均为 `true`。
- Golden 仍为 `pending-independent-review`。本轮只更新候选，不替代完整 60 分钟稳定性记录或独立冻结。

## 2026-08-16 专业图形跨渲染 / PDF 候选

- 候选目录：`output/phase2-professional-composite/vector-boolean-mask-r0-r2-20260816/`；固定 Professional Composite 同时包含普通 Vector、Live Boolean、两段独立 alpha Mask、Frame Clip 与 Slice。
- HeadlessChrome 151、1440×960、DPR 1、WebGPU 可用；console 为 `Errors: 0`。三轮中位数：Render P95 **3.3 ms**、Input-to-render P95 **3 ms**、Input backlog P95 **0.04 ms**，三项自动 Gate 均为 `true`。
- 真实页面点击 **Export PDF** 成功产出 `Page-1.pdf` 和 `Page-1.compatibility.json`；下载均无失败。兼容性 sidecar 明确记录 `pdf-rasterization` fallback，说明旧候选为带 `#ffffff` matte 的 JPEG 光栅页，未把原生矢量/alpha 保真误记为完成。
- 该候选与 `src/lib/svg-export.test.ts` 的同源测试共同固定：Rust 派生的 Vector 路径、Live Boolean、alpha Mask 和 Slice 均进入同一 SVG 源，PNG/PDF 再光栅化这份源。Golden 仍为 `pending-independent-review`，需由独立审核者冻结。

## 2026-08-16 RGBA PDF / 字体交付复验

- 专业 fixture 的 **Export PDF** 实际下载成功；PDF 字节包含 `%PDF-1.4`、`/Filter /FlateDecode` 与 `/SMask`，不含 `/DCTDecode`。这证明透明 PDF 走的是 lossless RGBA + alpha soft mask，而非 JPEG 白底。
- 同一 fixture 的 **Export SVG** 实际下载包含 `data-makefigma-source-revision` 与隔离 `@font-face`；sidecar `sourceRevision = 0`，没有 `font-asset` fallback。其余确实不可等价的 Effect/Image 能力仍保留结构化 fallback。
- 这仍不是原生可编辑 vector PDF，也不替代独立 Golden 审核；`pdf-rasterization` 保持可见，避免把格式可读性误称为编辑保真。
