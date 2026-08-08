# ADR 0025：平铺的外观/结构 Operation 契约（不引入聚合子消息与具名子命令）

状态：已采纳（Phase 2 收尾）

## 背景

`docs/phase2-common-nodes-implementation-plan.md` §7.1 的**原始提案**建议 protobuf 线格式引入若干聚合子消息与具名命令：

- `SceneNode` 内嵌 `StrokeProperties stroke_properties` 与 `NodeProperties properties` 两个聚合子消息，Paint 数组落在 `fills=22` / `strokes=23`；
- Operation 新增 `MoveNode`（携带 `page_id` + `relative_transform`）、`SetStrokeProperties`、`SetNodeProperties`、`DeleteSubtree` 等具名命令。

而**实际落地**（权威以 `schemas/proto/editor/v1/editor.proto` 为准）与提案分歧：

1. **字段号**：22–34 在更早的 Phase 2 切片里已被 stroke/几何标量字段占用（`stroke_cap_start=22` … `corner_smoothing=34`）。Paint 数组与扩展因此追加在其后——`SceneNode.fills=35`、`strokes=36`、`constraints=37`、`extensions=38`；`AppearanceUpdate.fills=22`、`strokes=23`、`constraints=24`。
2. **无聚合子消息**：所有 stroke/节点属性**平铺**进 `SceneNode` 与 `AppearanceUpdate`（`fill`/`stroke`/`stroke_width`/`stroke_cap_*`/`stroke_join`/`stroke_miter_limit`/`stroke_dash_pattern`/`stroke_weights`/`stroke_align`/`corner_radii`/`corner_smoothing`/`clips_content`/`arc_data`/`relative_transform`/`constraints` 等逐字段并列），没有 `StrokeProperties`/`NodeProperties` 两级结构。
3. **无具名结构命令**：跨父级移动用 `SetNodeParent`（几何有意省略，reducer 保持世界视觉位置，见 [ADR 0016](0016-canonical-position-id.md) 与实现计划 §8.1）；子树删除在 TS 层展开为 child-first 的多条 `DeleteNode` + 服务端完整性校验（见 [ADR 0024](0024-delete-subtree-atomicity.md)）。`MoveNode`/`DeleteSubtree`/`SetStrokeProperties`/`SetNodeProperties` 均未落地。

protobuf 字段号与线格式契约一经存量文档/存量 Operation 写入即**不可逆**。若后续有人把「实现与最初计划不符」误判为「实现待纠偏」，去把平铺字段重构成聚合子消息、或把字段号挪回 22/23，将造成**破坏性的持久化契约变更**（旧快照、旧 Operation、Canonical Hash 全部失配）。本 ADR 冻结「平铺 + 现字段号」为**最终形态**，消除该误纠偏风险。

## 决定

采纳**平铺契约**为 Phase 2 最终形态：

- **字段号**以 `editor.proto` 现值为准，永不回退到 §7.1 原始提案的 22/23。新增字段一律 append-only 追加到当前最大字段号之后。
- **不引入** `StrokeProperties`/`NodeProperties` 聚合子消息。stroke 与节点属性平铺进 `SceneNode`/`AppearanceUpdate`/`GeometryUpdate`。
- **不引入** `MoveNode`/`DeleteSubtree`/`SetStrokeProperties`/`SetNodeProperties` 具名命令。结构操作复用已落地的 `SetNodeParent`（[ADR 0016](0016-canonical-position-id.md)）与 `DeleteNode` + 服务端校验（[ADR 0024](0024-delete-subtree-atomicity.md)）。
- `extensions`（`map<string, bytes>`，`SceneNode.extensions=38`）仍是唯一的未知/未支持 namespaced 数据通道（[ADR 0023](0023-forward-compatibility-extensions-and-unknown-node-degradation.md)），不得用无类型 map 替代正式的平铺字段。

## 理由

- **append-only 已足够**：protobuf 的向后兼容只要求字段号不复用；平铺标量字段与聚合子消息在线格式上都能 append-only 演进，聚合并不带来额外的兼容性收益，反而多一层可空子消息的 present/absent 语义分支，放大 Hash 与迁移的边界条件。
- **单一真相**：平铺字段与 Core 的 `SceneNode`/`AppearanceUpdate` 结构一一对应，生成的 TS 类型、Canonical Hash 输入、迁移映射都是一层扁平字段，减少「子消息缺省 vs 字段缺省」的歧义。
- **结构操作复用既有通路**：`SetNodeParent`（几何省略、reducer 保位）与 `DeleteNode`（child-first + 服务端完整性校验）已通过验收并有回归测试；再叠加 `MoveNode`/`DeleteSubtree` 具名命令会在命令集、Undo/Redo、Hash 粒度、线格式各层新增冗余通路而无新增语义。

## 后果

- 实现计划 §7.1 / §8.1 / §8.3 均已就地标注「实现现状」段，指向本 ADR 与 ADR 0016 / 0024，作为权威口径；原始提案文字保留为历史需求描述。
- 未来若确有需要 Core 原生表达聚合属性或子树删除（例如为更粗的 Hash 粒度或单命令原子性），须回到本 ADR 追加**迁移决策**（新字段号 / 新命令 + 双读兼容 + 迁移窗口），而不得就地改写现有平铺字段或字段号。
- 兼容性矩阵与字段号表以 `editor.proto` 为单一权威来源；文档中任何字段号表若与 proto 分歧，以 proto 为准并回补文档。
