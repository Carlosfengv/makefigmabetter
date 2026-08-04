# ADR 0016：Canonical PositionId 与确定性子节点顺序

状态：已采纳（Phase 0.10 基础）

## 决定

- 每个 Node 保存 Canonical `PositionId { key, actor }`。同一父节点的排序固定为 `parentId → PositionId → NodeId`，不从 UI 数组顺序推断。
- `key` 是 128-bit 间隙排序空间；在两个相邻 key 间取中点。相同 key 的并发分配由可信 actor 的稳定 ID 打破排序，因此重放顺序不会改变最终文档顺序。
- 无 PositionId 的 v1–v4 Snapshot 使用 NodeId 派生默认 PositionId 迁移；Snapshot v5 显式保存 `positionId`。旧 snapshot hash 不做验证，因为迁移后 Canonical Hash 必然变化。
- 批量 Worker 投影保留 `positionId`，即使本次编辑只改文本、颜色或尺寸，也不能遗失已有子节点顺序。

## 后果

Phase 0 现在冻结了顺序的 Canonical 表达、排序和间隙耗尽错误边界。UI 层级拖拽、跨父节点 Move、自动 rebalancing、服务端 PositionId 转换和乱序 Operation merge 仍属于后续 Phase；这些功能必须复用本 ADR 的排序关系，不能再次引入数组索引作为持久顺序。
