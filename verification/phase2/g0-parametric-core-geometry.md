# Phase 2 G0 验收记录：Polygon / Star Core 几何（候选切片）

- 日期：2026-08-09
- 状态：Core、WASM 与 Canvas 候选通过；**G0 未关闭**。

## 本次实现

`editor-core::geometry::parametric_shape_outline` 以受限的 Polygon/Star 参数生成画布空间的 Fill 轮廓：首点位于顶部、点序顺时针，并拒绝非有限尺寸、少于 3 个顶点、超过 100 个顶点以及越界的 Star 内半径比例。`editor-wasm` 的 `parametric_shape_outline_json` 仅返回派生点集及其 Bounds，不把几何数组持久化到 Canonical Snapshot。

编辑 Worker 在 WASM 就绪后调用该桥接并以有限容量缓存结果；Canvas Polygon/Star 的 Fill 消费该结果，Stroke 则将其作为 Rust 闭合折线 tessellator 的唯一输入（含 dash/join）。无 Stroke Fill Bounds 直接读取 Core outline 返回的 bounds，含 Stroke 的空间/选择 Bounds 则直接读取 tessellator 的 bounds。Worker Hit Test 使用 Core 的 NonZero Fill 桥；SVG 导出从冻结快照异步取得同一桥接结果，PNG/PDF 再由该 SVG 栅格化；WASM 尚未就绪时保留等价 TypeScript 公式作为显式启动回退。

`Convert to Vector` 将当前派生闭合轮廓解析为一个新的 `VectorPath`，然后由同一笔 Core create/delete/reposition 事务替换原节点并保持其层级、变换、外观与层级位置。该新 ID 的结构替换让普通 Core Undo/Redo 精确恢复原始参数节点，无需临时或特殊历史记录。

## 验证

- `cargo test -p editor-core parametric_outline`：2 项通过，覆盖顶部起点、顺时针、有界输出与不可信参数拒绝。
- `cargo test -p editor-wasm parametric_shape_geometry_bridge_returns_core_derived_clockwise_outline`：1 项通过，覆盖 Core→WASM 派生轮廓桥接。
- `cargo test -p editor-wasm parametric_shape_conversion_is_one_undoable_create_delete_reposition_batch`：1 项通过，覆盖带 Relative-v1 父级的 Core 转换与 Undo。
- `cargo test -p editor-wasm parametric_shape_hit_bridge_uses_core_non_zero_fill`：1 项通过，覆盖 Polygon/Star 的 Core NonZero Fill 命中。
- `pnpm test -- parametric-shape`：629 项通过。
- `pnpm build`：通过。
- 固定 `phase2-professional-composite` 真实浏览器：WASM 状态为 ready，Polygon/Star 可见，控制台 `0` error；截图：`output/playwright/phase2-g0-core-outline-20260809T1249Z.png`。
- 同一真实浏览器 Fixture：Polygon 转为 5 点 `Polygon vector`（r0→r1），Undo 恢复 Polygon（r2），Redo 恢复 `Polygon vector`（r3）；Star 随后转为 10 点 `Star vector`（r4）。两条路径控制台均为 `0` error。
- 同一 Fixture 的 SVG、PNG 与 PDF 页面导出均下载成功，且没有浏览器 console error；三条导出共享冻结的 Rust/WASM Fill 轮廓。
- 同一真实浏览器 Fixture 中，`Star` 作为 `Professional composite` 的嵌套子层，先在 Inspector 旋转至 45°（r0→r1），再将西侧控制柄跨过东侧完成镜像（r1→r2；正几何保持，变换为 180°）。Undo 与 Redo 分别到 r3、r4，控制台始终为 `0` error。
- 2026-08-10 真实浏览器复核：`Star inner ratio` 从 `0.5` 更新为 `0.35`，Canonical Hash 从 `64d0d2307c85` 变为 `3ccf77214f44`；随后 Convert to Vector 得到 10 锚点的 `Star vector`，Hash 为 `3a935ddd746d`，控制台 `0` error。Reset demo 恢复固定 Fixture 的 `64d0d2307c85`。

## 尚未关闭的条件

- 仍需独立审核者在冻结源码上重跑该矩阵并签署；本记录仅构成候选证据。
