# Phase 2 图层类型 P1 验收记录：Relative-v1 Group Bounds

- 日期：2026-08-08
- 状态：自动候选通过；仍需在最终冻结源码上进行 Core/WASM、服务重放和真实浏览器组合验证。
- 覆盖源码：`src/lib/transaction-batch.ts`、`src/lib/scene-transform.ts`、`crates/editor-core/src/lib.rs`。

## 实现

`resolveCoreBatch` 现在会收集受到更新、重组或嵌套变换影响的 Group 及其祖先。在同一 Core 事务末尾，它只归一化这些 Relative-v1 Group，并以父级先于子级的最终 `update` 投影追加到原子 batch。归一化期间保持每个 child 的世界变换不变。

这避免了此前由个别画布拖拽调用方手动补齐 Group Bounds 的隐式契约：Inspector 数值编辑、旋转和其他同样进入 `resolveCoreBatch` 的操作现在共享同一收口路径。

Core 也已在每个事务应用完毕、写入 revision/history 之前检查 Group 非空性。`Group + child` 的同事务创建仍可提交；单独创建空 Group 会以 `EmptyGroup` 拒绝，并且不改变文档 revision、Canonical Hash 或节点集合。已有“最后一个 child 移出时自动解散 Group”的路径保持原子且可 Undo/Redo。

同时修复了 v16–v19 Phase 2 固定快照中把 Text 挂在 Line 下的非法父子关系，并重新冻结对应的 Canonical Hash 与清单 SHA-256，使迁移回归能在当前容器约束下实际执行。

## 自动验证

- `pnpm vitest run src/lib/transaction-batch.test.ts src/lib/selection-rotation.test.ts`：39 项通过。
- `pnpm test`：133 个文件、527 项通过。
- `cargo test --workspace`：全部通过（含 `editor-core` 95 项、`editor-wasm` 40 项及服务/渲染器测试）。
- `pnpm check:phase1-snapshot-fixtures`、`pnpm build`、`git diff --check`：通过。

## 未关闭条件

- 需覆盖嵌套旋转/镜像 Group、Inspector 编辑、Resize、Reparent、Undo/Redo、WASM 及服务重放的最终冻结矩阵。
