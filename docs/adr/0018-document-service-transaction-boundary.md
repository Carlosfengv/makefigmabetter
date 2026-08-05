# ADR 0018：Document Service 的 accepted revision 事务边界

状态：已采纳（Phase 1.3 基础）

`crates/document-service` 使用独立 SQLite 数据库作为单进程 Document Primary 的 durable store。一个 `IMMEDIATE` 数据库事务同时完成以下动作：读取当前 accepted revision、检查已确认 Operation、调用 Canonical Reducer、更新 Document Snapshot/Hash、插入原始 Protobuf Envelope 和 assigned accepted revision。

Operation 幂等键为 `(document_id, operation_id)`；同一键且相同 payload hash 返回既有 accepted revision，不再次调用 Reducer。不同 payload hash 使用同一 Operation ID 会被拒绝。`(document_id, accepted_revision)` 也有唯一约束，避免两个写入得到同一 revision。

服务端从可信 `TrustedPrincipal` 确定 tenant 和 actor，客户端 Envelope 的 actor 仅作为未可信 transport 字段。payload hash、ID 长度、schema version、base revision、文档 tenant 和 editor ACL 均在进入 Reducer 前校验。原始 Envelope bytes 被保存，以便未来字段能通过 Gateway/队列不丢失地转发。

此阶段的 Reducer 是服务边界而非第二个文档模型：后续 protobuf Canonical Operation → editor-core adapter 必须在同一边界实现，不能在 HTTP Gateway 或前端复制语义。SQLite 是单客户端开发和恢复证据的 durable 事务实现；生产 Postgres primary/fencing、对象存储 Snapshot 和横向扩展仍属于后续部署工作。
