# ADR 0002：命令和事务契约

状态：已采纳（Phase 1 基线）

## 决定

- `Command` 表达单一编辑意图；`Transaction` 以 `transactionId`、`baseRevision` 和命令数组封装该意图。
- Document Core 只有在 `baseRevision` 等于当前 `revision` 时才提交 Transaction。冲突以 `REVISION_CONFLICT` 返回，不能静默覆盖。
- Rust Reducer 会先在克隆的文档上完成全部校验和变更，再一次性递增 revision 并发布 `AppliedTransaction`。失败不改变文档、revision 或历史。
- `transactionId` 是幂等键：已接受的完全相同 Transaction 重试会返回原始 `AppliedTransaction`，不增加 revision 或 HistoryItem；同一 ID 携带不同内容会以冲突拒绝。Document 提供与 revision、Undo 缓存无关的 SHA-256 canonical hash，供 Snapshot、Operation 回放和未来服务端交叉校验。
- 接受后的 HistoryItem 记录 origin、原 revision、接受 revision，以及每个变化的 before/after 值。Document 为 `LocalUser` 事务维护语义 Undo/Redo 栈；Undo/Redo 产生新的单调 revision，而不是回拨 revision。该记录也是以后协同 Compensation Operation 的输入。
- UI → Worker 协议已使用同样的 ID、revision、确认结构。Worker 会将连续的 Create、Update、Delete 与 Duplicate 命令解析为只含稳定 ID 和完整确定属性的 Core 批次，再单次提交给 WASM Reducer；Duplicate 在进入 Core 前展开为带新 UUID 的 Create，完整保留 Paint、文本与位置。选择、视口、Undo/Redo 等 UI 或控制命令不能混入该批次。一次批次只接受一个 revision 和一个 HistoryItem；目前已有 1,000 个属性更新的单批回归测试。
- Main Thread 对 UI Transaction 执行单飞排队：只有当前事务收到 Ack 后才发送下一项，`REVISION_CONFLICT` 在观测 Worker 当前 revision 后最多重试一次。Inspector 的未确认 Update 会作为乐观投影叠加在最新 Worker Snapshot 上，Ack 后移除，避免快速受控输入被较早快照回写或静默丢字。
- 解析后的 Core Transaction 会被封装为版本化 Operation Envelope 再进入 Reducer。Operation 的幂等键独立于 transactionId，payload SHA-256 会覆盖具体 Command；本地 WASM 写入与未来远端回放使用同一路径。

## 不变量

- Node ID 在 Document 生命周期中不复用；删除的 ID 进入 retired 集合。
- retired ID 是 Snapshot 的组成部分，恢复后仍禁止复用。
- 单次 Transaction、Undo/Redo 与 `transactionId` 去重缓存分别受数量和估算字节预算限制；超限在提交前以 `RESOURCE_LIMIT` 拒绝，不能修改 Document。预算统计由 WASM 公开给 Worker，供性能报告采样。
- 节点名称不能为空；坐标、尺寸和旋转必须是有限值，尺寸必须大于零。
- 子节点的 parent 必须存在；有子节点的节点不能被单独删除。

## 后果

属性面板读取旧快照时，编辑器会明确拒绝过期写入而不是产生最后写入者静默覆盖。协同实现需要在此基础上增加服务端 acceptedRevision 和补偿逻辑，不能重新定义本地事务语义。
