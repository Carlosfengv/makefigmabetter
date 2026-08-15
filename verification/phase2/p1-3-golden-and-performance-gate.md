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
