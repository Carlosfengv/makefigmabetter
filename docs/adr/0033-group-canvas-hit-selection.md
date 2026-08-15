# ADR 0033：Group 画布命中与深层选择

- 状态：Accepted
- 日期：2026-08-10
- 范围：Phase 2 Group 的 Canvas 命中、选择边界与深层选择

## 决策

Group 没有自己的 paint，但其由 children 派生的世界 Bounds 是可直接选择的区域：

1. 点击 Bounds 的空白区域直接选择 Group；
2. Bounds 与可见 child 重叠时，普通点击优先命中 child 所属的最外层未锁定 Group，保持 Group 作为默认编辑边界；
3. 已选中该 Group 后的重复点击（浏览器双击路径）逐层进入嵌套 Group，最终到达被命中的 child；
4. Layers 面板始终可以直接选择 Group；隐藏或有效锁定的 Group 不参与该路径。

这让画布与图层面板的 Group 选择一致，同时保留直接编辑深层图层的确定性交互。

## 实现与验证

- `src/lib/hit-test.ts`：Group Bounds 参与命中，重叠时优先非 Group 的可绘制 child；
- `src/lib/canvas-selection.ts`：`resolveGroupSelectionTarget` 维护 Group 边界与逐层 drill-down；
- `src/lib/hit-test.test.ts`：覆盖 Group Bounds、空白区域和 child 优先级；
- `src/lib/canvas-selection.test.ts`：覆盖两层嵌套、重复点击、已选 child 及损坏 parent cycle。

## 后果

这不是像素级 Group paint hit；Bounds 仅用作编辑选择 affordance。最终 Golden 与独立浏览器验收仍是 Phase 2 Gate 的一部分。
