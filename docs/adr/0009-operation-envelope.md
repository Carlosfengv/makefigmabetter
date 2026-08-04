# ADR 0009：版本化 Operation Envelope 与本地回放

状态：已采纳（Phase 0 基线，协同传输待实现）

## 决定

- `Command` 继续表达本地意图；持久/回放边界使用已解析的 `OperationEnvelope`。Envelope 固定包含 schema version、Document/Operation/Transaction/Actor ID、base revision、causal parents、具体 Transaction 与 SHA-256 payload hash。
- Document 对同一 Operation ID 的重复投递返回首次 `AppliedOperation`，不增加 revision；复用 Operation ID 但 envelope 内容不同会在修改前拒绝。payload hash、schema、Document ID 与 Transaction 字段不一致同样拒绝。
- WASM 的本地创建、重命名、几何/外观更新、删除、移动及批量写入均通过 Envelope 进入同一个 Rust Reducer。远端 Operation 使用 `RemoteOperation` origin，不进入本地 Undo 栈。
- causal parent 集合在计算 fingerprint 前排序去重，消除合法传输顺序差异；Operation 去重缓存单独受数量和字节预算限制，并经 WASM 内存统计公开。

## 当前边界

浏览器本地 Document 暂使用确定性的 `DocumentId(0)`、`ActorId(0)` 占位，且内部 Worker/WASM 边界仍是版本化 JSON。ADR 0016 已冻结并实现了 PositionId 的本地 Canonical 排序与 Snapshot 迁移；服务端认证后注入的 actor/tenant、Protobuf wire message、持久 pending Operation queue、accepted revision 分配，以及乱序 Operation 的 PositionId 转换尚未实现。

## 后果

未来 WebSocket、离线队列、数据库 Operation Log 和后端 Primary 必须传输同一 Envelope 语义，不能再次把 UI Command 当作网络协议。引入 PositionId 或 Protobuf 时，必须保留 payload hash、Operation ID 幂等、Document ID 校验和当前回放 Fixture。
