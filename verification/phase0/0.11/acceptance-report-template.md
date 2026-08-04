# Phase 0.11 验收报告

| 字段 | 记录 |
| --- | --- |
| Phase / Step | Phase 0 / 0.11 |
| Build | commit / build ID / WASM engine semantics version |
| Environment | OS、浏览器版本、GPU、DPR、屏幕分辨率 |
| Test Fixture | `F-PHASE0-BASIC-CARD`、fixture SHA-256 |
| Preconditions | 存储状态、网络、Feature Flag；Golden 固定使用 `renderer=canvas2d`（不依赖 WebGPU/WebGL2 可用性） |
| Procedure | 启动、载入 Fixture、执行平移/缩放/选择、采集截图与控制台 |
| Expected | Canvas 初始化；无未处理异常；日志和性能摘要可读；截图与已审核 Golden 一致 |
| Actual | 待填写 |
| Metrics | 渲染 samples、P50、P95、最大值；WASM/Undo/CPU/GPU 资源（可用时） |
| Evidence | PNG、控制台日志、`EditorSnapshot.diagnostics`、`EditorSnapshot.performance`、命令输出路径 |
| Defects | 编号、严重级别、负责人，或“无” |
| Result | PASS / FAIL / BLOCKED |
| Sign-off | 验收人、日期 |

## 采集要求

1. 使用 `bash scripts/capture-phase0-evidence.sh <URL> <evidence-directory>` 固定 1440×960 浏览器窗口并保存截图、DOM 快照、控制台输出、浏览器能力日志、`golden-verification.json` 和 `evidence-metadata.json`。后者记录运行时、应用版本、WASM 语义版本、Core Snapshot Schema 版本、生成 WASM 的 SHA-256、Fixture/Manifest 及采集产物的 SHA-256。该脚本会追加 `fixture=phase0-basic-card&renderer=canvas2d`，确保 Golden 不因可选 WebGPU Scene Spike 的能力差异而漂移。性能摘要只在 Bridge 最终就绪后的稳态 render 开始记录；正式基准仍须预热 30 秒、至少运行三次。
2. 首次截图必须由独立验收人审核后，确认候选采集的 SHA-256，再填入 Golden manifest 的两个 SHA-256 值并将 PNG 纳入版本控制。自动重放的一致性只证明采集可复现，不构成审核签收。
3. 后续差异不得覆盖基线；保存新的证据目录，引用本报告并标注 PASS、FAIL 或 BLOCKED。
4. 可运行 `pnpm evidence:report <evidence-directory>` 从已保存的元数据与 Golden 校验结果生成预填验收报告；验收人仍需检查完整证据并填写缺陷与签字，生成器不会自行签收。
