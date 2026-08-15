# Phase 2 图层类型 P2 验收记录：Line 最小长度固定端点

- 日期：2026-08-08
- 状态：自动候选通过；仍需最终冻结源码上的浏览器交互与服务重放矩阵。
- 覆盖源码：`src/lib/line-endpoint-resize.ts`、`src/lib/relative-line-endpoint-resize.ts`。

## 实现

Line 端点拖拽现在先确定未拖拽的对侧端点，再以请求方向生成最小长度为 `4` 的线段。请求长度不足 `4` 时，拖拽端点被投影到以固定端点为圆心、半径 `4` 的位置；请求与固定端点重合时采用拖拽前的正向基。该规则同时用于 Legacy `x/y/rotation` 和 Relative-v1 矩阵路径。

因此最小长度钳制不会再移动固定端点。Relative-v1 实现通过现有 world-to-local 逆变换和 `relative × translate × rotate` 写回，覆盖旋转、镜像父级下的世界坐标不变量。

## 自动验证

- `pnpm vitest run src/lib/line-endpoint-resize.test.ts src/lib/relative-line-endpoint-resize.test.ts`：10 项通过。
- `pnpm vitest run src/lib/transaction-batch.test.ts src/lib/selection-rotation.test.ts`：39 项通过（回归保护）。

## 未关闭条件

- 需以最终冻结源码覆盖真实画布的两端拖拽、跨越对侧、零距离、Undo/Redo 和服务重放。
- Group 空白区域命中语义仍是独立 P2 产品决策，未包含在本记录中。
