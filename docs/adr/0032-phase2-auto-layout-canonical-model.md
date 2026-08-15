# ADR 0032：Phase 2 Auto Layout 使用 Frame 容器模式与子项尺寸策略

状态：已采纳（L3 第一切片）

## 背景

普通 Frame 的尺寸与子节点几何目前由显式 Geometry 和 Constraints 维护。这不能表达 Button、List、Card 或 Form 所需的内容驱动尺寸与确定性排列。把 Hug/Fill 临时投影为宽高会破坏 Undo、重放和嵌套布局，因此布局输入与计算结果必须由 Canonical Core 分离保存。

## 决定

- 只有 `Frame` 可成为 Auto Layout 容器。`None` 保持既有 Frame/Constraints 语义；`Horizontal` 与 `Vertical` 是第一阶段的单轴方向。
- Frame 布局字段为：mode、四边 padding、item spacing、主轴/交叉轴 alignment、wrap。第一切片仅接受 `wrap = false`，但持久化字段和验证边界先固定，避免后续改写 Snapshot 语义。
- 每个节点都有布局子项字段：主轴和交叉轴尺寸策略 `Fixed`/`Hug`/`Fill`，每轴可选 min/max，以及 `absolute`。这些字段只在直接 Auto Layout Frame 子项上生效；否则被原样保存且 Inspector 显示 NotApplicable。
- `Fixed` 使用节点现有宽高；`Fill` 仅在容器主轴上参与剩余空间的确定性分配；`Hug` 在第一切片只接受可测量文本和容器，其他节点退回其已保存的宽高。文本测量来自 Core 的稳定近似，浏览器字体度量不能进入 Canonical 结果。
- Absolute 子项不参与测量、分配或流式定位，保留它的显式 Geometry/relative transform。Auto Layout 与 Constraints 不可同时计算同一子项；流式子项的 Constraints 被忽略但不删除。
- Core 在一次事务的末尾收集受影响的 Auto Layout Frame 及其祖先。布局按“测量 → 分配 → 定位”执行，子 Frame 先完成，再处理父 Frame。受影响集只覆盖变更节点的容器祖先及其必要子树，禁止默认整页扫描。
- 所有内部结果归一化到 `1e-6`，每轮最多 10,000 节点、64 层容器深度和 16 次 Hug 收敛迭代。超限、循环、非法 min/max 或不能满足的固定约束以具名 Core 错误整体拒绝事务。
- 计算出来的 Geometry 与普通 Geometry 一样是 Canonical 状态并参与 Hash、Undo/Redo、Snapshot、服务重放与导出；布局缓存、dirty set 和测量中间值不是持久状态。

## 第一切片范围

实现 Horizontal/Vertical、无 Wrap、固定子项、padding/gap、start/center/end alignment，及其事务/Undo/Hash/Snapshot 通路。Hug/Fill、min/max、absolute、wrap、嵌套 dirty set 和 Inspector 按后续切片顺序启用，不能用 UI 先行的宽高覆盖模拟。

## 后果

- Frame 更新不能再由 Worker 直接猜测子项坐标；所有流式布局结果必须在 Rust Core 的同一事务内产生。
- 渲染器、Hit Test 和导出只消费已投影的 Canonical Geometry，因此不各自实现布局算法。
- 已有非 Auto Layout 文件字节和视觉行为不变；缺失字段按 `None`/`Fixed`/零 padding/零 spacing 解码。
