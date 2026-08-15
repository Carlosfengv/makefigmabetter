# ADR 0026：Polygon 与 Star 保留为可编辑参数节点

状态：已采纳（Phase 2 G0）

## 背景

Phase 2 图层类型清单要求 Polygon 与 Star 是独立 `NodeKind`，而不是创建后即丢失语义的普通路径。它们的点数、Star 内半径、朝向、Resize 和转换语义会同时影响 Canonical Hash、快照、操作重放、命中、渲染与导出；这些规则若不先固定，不同消费者会生成不同几何。

## 决定

- 新增独立 `Polygon` 与 `Star` NodeKind，保留参数，不在创建时转换为 Vector。
- Polygon Canonical 参数为 `point_count`；Star Canonical 参数为 `point_count` 与 `inner_ratio`。
- `point_count` 是整数，范围 **3–100**；Star `inner_ratio` 是有限数，范围 **0.05–0.95**。Polygon 不存储无意义的 inner ratio。
- 生成几何以节点局部外接矩形的中心为圆心，**顶部**为第一个外顶点，后续顶点顺时针排列。Star 在相邻外顶点间插入内顶点；它使用 NonZero 填充规则，允许凹形而不接受自交参数化。
- Resize、旋转、镜像复用普通可绘制节点的 Canonical 几何/仿射变换规则；Resize 仅改变外接矩形，不重写参数。点数和 inner ratio 只经显式 Inspector/Operation 修改。
- Fill、Stroke、Bounds、Hit Test、Canvas 和 SVG 必须消费同一份由 Canonical 参数生成的局部多边形。GPU 在没有对应原生 primitive 时回退 Canvas，不伪装为 Rectangle。
- `Convert to Vector` 是未来 VectorPath 内核落地后的单个可撤销结构事务：保留视觉几何、替换 NodeKind 与参数，并在 Undo 时精确恢复原参数节点。G0 不以临时多点近似替代此命令。

## 后果

- 需要 append-only 扩展 Proto、Core、WASM、服务适配器与所有穷尽匹配；旧客户端继续按 ADR 0023 的文档级只读策略处理未知 NodeKind。
- Point budget 有明确上限，避免把参数节点变成绕过 VectorPath 预算的入口。
- 圆角、多边形布尔、节点级编辑和曲线控制柄不属于 G0；这些属于后续 Vector/Boolean 工作包，不能偷偷写入 Polygon/Star 参数模型。
