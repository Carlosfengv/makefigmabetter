# ADR 0012：本地单写者 Lease 与自动接管

状态：已采纳（Phase 0 / Phase 1 过渡）

## 决定

- 同一浏览器、同一文档仍只允许持有 Web Lock 的 Owner 写入 Journal、Manifest 与 Snapshot；Follower 只读并通过 BroadcastChannel 接收已持久化投影。
- Follower 不把一次 `ifAvailable` 失败视为永久只读。它会以有界延迟重试锁请求；Owner 关闭或卸载释放 Lease 后，Follower 自动成为唯一 Writer。
- React 卸载或切换只读时会先禁止新编辑，等待该 Owner 已接受的串行持久化队列排空，再停止重试并释放 Lease；因此旧 Owner 不会在新 Owner 接管后用较早 Manifest 覆盖新状态。浏览器不支持 Web Locks 时保持显式只读，不以弱互斥降级为多写者。

## 后果

写入权接管不再要求刷新页面，并保留“同一时刻最多一位 Owner”的平台保证。完整 Worker panic/restart、跨浏览器协调和服务端 pending Operation Ack 仍不是该机制的职责，必须由后续恢复与协同路径处理。
