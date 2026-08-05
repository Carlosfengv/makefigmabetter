# Phase 1.3：Document Service 耐久与配额候选证据

状态：本地自动化候选通过；不是 W1 或 Phase 1 完成声明。

`makefigma-document-service` 在 SQLite `IMMEDIATE` 事务中同时更新 Document Snapshot、accepted
revision 与按 `(document_id, operation_id)` 唯一的 Operation 记录。只有 commit 成功才返回 Accepted。

当前自动覆盖包括：

- 已接受 Operation 的重放在服务重开后仍返回同一 revision，reducer 不会第二次执行；
- Hash 篡改、相同 Operation ID 不同 payload、过期 base revision、非授权 actor 都不会改写 Document；
- 超过 256 MiB Snapshot 或 4 MiB Operation 的请求在 reducer/SQLite 写入前以 `ResourceLimit` 拒绝，
  revision 和 Canonical hash 保持不变；
- HTTP 路由验证 protobuf 入口、未知字段原字节保留、协议兼容错误和服务重开后的 Snapshot/幂等重放。

复现：

```sh
cargo test -p makefigma-document-service
cargo test -p makefigma-document-api
```

仍需 W1 的完整浏览器离线/刷新/服务重启/Conflict/Permanent Reject 组合，以及提交绑定的独立验收。
