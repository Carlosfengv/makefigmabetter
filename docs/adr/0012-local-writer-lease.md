# ADR 0012：本地单写者 Lease 与自动接管

状态：已采纳（Phase 0 / Phase 1 过渡）

## 决定

- 同一浏览器、同一文档仍只允许持有 Web Lock 的 Owner 写入 Journal、Manifest 与 Snapshot；Follower 只读并通过 BroadcastChannel 接收已持久化投影。
- Follower 不把一次 `ifAvailable` 失败视为永久只读。它会以有界延迟重试锁请求，同时广播带时间戳和随机 ID 的编辑意图；Owner 只向更新的意图交接，避免较早的请求在多标签竞争中重新夺回写入权。
- React 卸载、刷新或切换只读时会先禁止新编辑，再同步释放 Lease，不能等待旧页面可能已经停止推进的持久化 Promise。每次 Journal/Snapshot/Manifest 写入仍各自保持原子性；完整跨标签持久化 fencing 由后续服务端 accepted revision 处理。浏览器没有 Web Locks 时保留本地编辑降级，但多标签一致性不受保证，兼容矩阵按 Partial 记录。

## 后果

写入权接管不再要求刷新页面，并保留“同一时刻最多一位 Owner”的平台保证。完整 Worker panic/restart、跨浏览器协调和服务端 pending Operation Ack 仍不是该机制的职责，必须由后续恢复与协同路径处理。
