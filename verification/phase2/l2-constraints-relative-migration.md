# Phase 2 L2 验收记录：旋转 Frame 下的 Constraints 迁移

- 日期：2026-08-08
- 状态：自动候选通过；尚未完成 L2 全部范围。
- 覆盖源码：`crates/editor-core/src/lib.rs`。

## 实现

当 Frame 的 Resize 同时具有旋转或 Relative-v1 变换时，旧式 world-space 的**直接** constrained child 不再被静默跳过。Core 在同一个 Canonical Transaction 中把 child 的当前世界变换转换为 Frame-local Relative-v1 矩阵，随后使用与已现代化 child 相同的约束公式写入新的局部位置与尺寸。

迁移与 Frame 几何更新、历史记录及 Undo/Redo 同属一笔事务；初始 Legacy child 的 `relativeTransform` 会在 Undo 时恢复为缺失状态。通过只覆盖直接 child，Core 不会猜测 Legacy Group 的派生 Bounds/局部空间；穿过 Legacy Group 的完整子树迁移仍属于 L2 待办。

## 自动验证

- `cargo test -p editor-core rotated_frame_resize_migrates_legacy_direct_constraints_to_local_matrix_space`：通过。
- `cargo test -p editor-core`：95 项通过。
- `pnpm test`：133 个文件、530 项通过。

## 未关闭条件

- Legacy Group 路径下的 constrained child 必须以完整子树迁移完成，不能以局部坐标猜测替代。
- 仍需覆盖重入 Resize、镜像、Clip、Reparent、零尺寸 Scale、服务恢复，以及 Auto Layout 对普通 Constraints 的覆盖规则。
