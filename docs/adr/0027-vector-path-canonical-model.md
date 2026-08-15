# ADR 0027：VectorPath 的 Canonical 模型与资源预算

状态：已采纳（Phase 2 G1）

## 决定

- `Vector` 是独立 `NodeKind`，其 `vector_path` 是唯一持久化路径事实来源；Canvas、命中、SVG、Pen、Boolean、Mask 与 Outline Stroke 都不得保存各自的扁平化副本。
- `VectorPath` 由有序 `Subpath` 构成。Subpath 可 open 或 closed，Fill Rule 是整个 Path 的 `NonZero` 或 `EvenOdd`。
- 每个 `VectorPoint` 保存稳定 `PointId`、局部 position、可选 in/out handle 与 `Corner` / `Mirrored` / `Asymmetric` 点类型。Handle 是相对锚点的向量；Mirrored 的交互约束在 G2 写入命令时维持，而历史快照不隐式改写用户值。
- 空 Path 合法，用于开始 Pen 的暂态提交与空 Vector 导入；非空 Subpath 至少一个点，closed Subpath 至少三个点，PointId 在一个 Path 内必须唯一。相邻完全重合的锚点、NaN/Infinity 和超限输入被确定性拒绝。
- 硬上限：每 Path 64 个 Subpath、8,192 个 Point、1 MiB 规范化序列化预算；每个点最多两个 2D handle。上限在 Core、协议解码与编辑命令入口共同执行。
- 初始 G1 以完整 `SetVectorPath` 原子命令保证 Snapshot、Hash、Undo/Redo、跨端重放正确；G2 会在同一数据模型上追加命名的插入、删除、拆分、连接和控制柄命令，不能另建旁路表示。
- 所有几何运算在 Vector 节点局部空间进行。`x/y/width/height/rotation/relative_transform` 仍复用普通节点变换；路径编辑不直接改写这些节点几何字段。

## 后果

- G1 可以先验证数据完整性与预算，再引入 flatten/tessellation，避免 Pen Tool 将未经验证的大型路径直接推给渲染器。
- Polygon/Star 的 Convert to Vector 可以把其生成轮廓写为一个 closed `VectorPath`，同时保留为单一可撤销结构事务。
- Boolean 的派生结果不是 Canonical VectorPath；它将在 G3 按活结构规则生成并消费该类型。
