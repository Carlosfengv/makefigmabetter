# Phase 2 完成清单

- 状态：进行中；本清单是可复现的验收索引，**不构成 Phase 2 完成声明**。
- 基线：`main` @ `3430a5a` 加当前 Phase 2 remediation 工作区变更。
- 计划来源：[Phase 2 剩余能力落地计划](../../docs/phase2-remaining-implementation-plan.md)。
- 更新规则：每个工作包仅可在自动检查、浏览器证据和要求的独立签署均归档后标为完成；实现者不得签署 Golden、屏幕阅读器或 60 分钟稳定性 Gate。

## R0：集成与验收基线

| 检查项 | 自动入口 / 证据 | 当前状态 |
| --- | --- | --- |
| 前端测试、lint 与生产构建 | `pnpm lint`、`pnpm test`、`pnpm build`；CI `web` job | 已接入 CI；需以最终冻结源码复跑 |
| Rust Core、服务与渲染器测试 | `cargo test --workspace`、`pnpm document:api:check`、`pnpm asset:api:check`、`pnpm workspace:api:check`、`pnpm mock:backend:check`；CI `rust`、`services`、`renderer-native` jobs | 已接入 CI；需以最终冻结源码复跑 |
| 协议和 WASM 生成物一致 | `pnpm protocol:check && git diff --exit-code`、`pnpm wasm:build && git diff --exit-code`；CI `protocol`、`wasm` jobs | 已接入 CI；需在干净 clone 验证 |
| 边界与兼容矩阵 | `pnpm check:boundaries`、`pnpm check:compatibility`；CI `web` job | 已接入 CI；兼容矩阵保持 Phase 2 Partial/Later 口径 |
| Snapshot 与 Phase 1 固定 Fixture | `pnpm check:phase1-snapshot-fixtures` 及 CI `phase1-fixtures` job | 已接入 CI；需以最终冻结源码复跑 |
| Common Nodes 固定 Fixture | `pnpm check:phase2-common-nodes-fixture`；CI `phase2-common-nodes-fixture` job；[manifest](common-nodes-fixture-manifest.json) | 已接入 CI；固定输入不是 Golden 签署 |
| Relative-v1 Group Bounds | [P1 自动候选](p1-group-relative-bounds.md)：事务级归一化、父先子后更新、世界变换保持；Core 事务后 Group 非空不变量；固定快照迁移回归 | 候选已覆盖；最终跨层冻结矩阵与独立审核待办 |
| Line 最小长度固定端点 | [P2 自动候选](p2-line-endpoint-invariant.md)：Legacy/Relative-v1 同规则，零距离回退正向基，旋转/镜像父级固定端点回归 | 候选已覆盖；最终跨层冻结与独立审核待办 |
| Constraints 旋转 Frame 迁移 | [L2 自动候选](l2-constraints-relative-migration.md)：Legacy 直接 child 在同一 Core 事务迁移为 Frame-local Relative-v1，再使用统一约束公式 | 直接 child 与 Group 子树候选已覆盖；最终跨层冻结待办 |
| 文本替换、选区样式与 Run 级颜色 | [L1 自动候选](l1-text-style-run-rebase.md)：Canvas 与 Inspector 共用 UTF-8 scalar 级重定位；Inspector 选区样式、画布 `contentEditable` 与版本化富文本剪贴板可经 Core/WASM/Canvas/SVG 保留 | 候选已覆盖；复杂脚本/IME 与独立辅助技术验收待办 |
| 文档状态一致性 | `docs/phase2-remaining-implementation-plan.md`、`docs/phase2-remediation-plan.md`、[preflight](preflight.md)、`docs/compatibility-matrix.md` | 进行中；所有未独立签署的 Gate 均须维持候选状态 |

## Milestone A：Common Nodes Gate

| Gate | 证据 | 当前状态 |
| --- | --- | --- |
| R1 跨文档 Copy/Cut/Paste | [R1 验收记录](r1-clipboard-cross-document.md)：`makefigma-node-clipboard-v1`、SHA-256、版本/字节/树/资源 Hash 校验、系统剪贴板与可序列化 fallback；真实浏览器已覆盖跨标签、跨文档的无资源/未授权资源/已授权资源、跨 Page 完整子树、Cut、Undo/Redo 与断线重放；服务重启后跨文档资源仍可读取 | 已完成 |
| R2 Mixed Inspector 独立 AT 复核 | [P1-2 记录](p1-2-inspector-capability-a11y.md) | 待独立审核 |
| R2 Golden、性能和稳定性独立冻结 | [P1-3 记录](p1-3-golden-and-performance-gate.md) | 待独立审核 |

## 后续工作包追踪

| 工作包 | 关闭条件摘要 | 当前状态 |
| --- | --- | --- |
| R3 | [旋转、键盘位移与基础 Shadow 候选](r3-rotation-control.md) 已接入；旋转、Undo/Redo、世界坐标方向键位移、基础 Shadow/Mixed Inspector 及核心键盘流程均已通过候选浏览器验证；完整跨辅助技术验收仍待办 | 候选完成，待独立审核 |
| G0–G5 | Polygon、Star、Vector/Pen、Boolean/Outline、Mask、Slice | 候选/部分完成；详见计划 §4.2–4.3，仍缺完整几何、交互、导出与跨层验收 |
| E1 | Effect Stack、离屏纹理池与降级报告 | 候选/部分完成；Core/Canvas/SVG 的首批 Stack、Blur 与 Blend 已接入，WebGPU 纹理池、PDF 降级与 Golden 待办 |
| L1–L3 | 高级文本、Constraints 收口、Auto Layout | 候选/部分完成；文本 Run、Relative-v1 Constraints 与单轴 Auto Layout 已有候选，完整交互和跨导出验收待办 |
| X1 | PNG/SVG/PDF 与兼容性报告 | 候选/部分完成；基础 SVG、Slice PNG/PDF 与兼容性输出已接入，完整节点/页面交付待办 |
| Q1 | 复杂 Fixture、60 分钟稳定性、独立设计师验收 | 实施中；见 [Professional Composite 候选记录](q1-professional-composite.md)。短采集已形成候选，Golden、完整 60 分钟及独立设计师验收仍待办 |

## 冻结记录

在最终源码冻结时，记录 commit SHA、`git status --short`、各 CI job、Fixture/manifest SHA-256，以及所有独立签署产物的位置。若源码、Fixture、协议或生成 WASM 发生变化，相关 Golden、性能和稳定性候选必须重新采集。
