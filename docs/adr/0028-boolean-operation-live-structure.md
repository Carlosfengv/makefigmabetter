# ADR 0028：BooleanOperation 保留活结构，Flatten 才生成 Vector

状态：已采纳（Phase 2 G3）

## 背景

`Union`、`Intersect`、`Subtract` 与 `Exclude` 不能以一次性路径结果冒充图层类型：这样会丢失输入节点、操作顺序与可编辑性，也无法让 Undo/Redo、远端重放和未来的 Inspector 恢复同一结构。ADR 0027 已规定 Boolean 的派生结果不是 Canonical `VectorPath`，但未冻结其节点、子树和退化输入语义。

## 决定

- 新增独立 `BooleanOperation` NodeKind，持久化 `Union`、`Intersect`、`Subtract` 或 `Exclude` 之一；派生边界、交点、环和填充结果均不得写进 Snapshot 或 Operation。
- Boolean 节点是结构容器：其直接 children 是操作数，按 Canonical `PositionId` 顺序读取；至少两个直接 children，且它们必须同页、同父级并在建立操作时整体移动到 Boolean 节点下。Boolean 本身不能成为自己的后代，也不能混入非直接操作数。
- 操作顺序确定如下：`Union` / `Intersect` / `Exclude` 对所有直接 children 聚合；`Subtract` 的第一个 child 是主体，其余 children 按 Canonical 顺序依次从主体移除。重排 children 会改变 `Subtract` 结果，因此是普通的可撤销结构操作而非仅展示排序。
- 只有 closed、非零面积的可绘制轮廓参与结果。开放路径、空 Vector、不可解析路径和退化面积以确定性“空操作数”处理，不制造临时填充；若所有操作数为空，派生结果为空但 Boolean 节点及其 children 保留。
- 交互预览、Canvas 命中、SVG/PDF 和 Flatten 必须调用同一 Rust 几何入口，并把 Fill Rule 与环方向一同交给该入口；TypeScript 只消费已验证的派生结果。
- `Flatten` 是单一可撤销结构事务：以当前 revision 的派生结果创建普通 `Vector`，保留 Boolean 节点的外部位置、变换、外观与层级位置，删除 Boolean 子树。Undo 必须恢复原 Boolean 节点、operation、children ID、顺序和局部变换；空结果仍可 Flatten 成合法空 Vector。
- Stroke → Fill Path 不是 Boolean 的近似旁路：它只能消费同一个 Rust stroke tessellation/轮廓入口，并以单一可撤销 Vector 替换命令交付。

## 后果

- Schema、Core Hash、Snapshot、WASM、Service reducer 和前端必须新增 operation 枚举与 `BooleanOperation` NodeKind；旧客户端按 ADR 0023 的文档级只读策略处理该未知节点。
- G3 的第一批实现可先建立活结构、Operation、Undo/Redo 和空/退化语义，再接入精确 path clipping；但在 Rust 结果入口未覆盖 Canvas、命中和 SVG 前，Boolean 不能标记为可用。
- 多个 Boolean 的嵌套、混合 fill rule、相切、重合边、自交、图片/文本 outline 和 PDF 输出需要进入固定退化 Fixture，不允许由各渲染器自行猜测。
