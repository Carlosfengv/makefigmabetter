# ADR 0019：Asset Service 的上传与下载边界

状态：已采纳（Phase 1.6 基础）

`crates/asset-service` 为单客户端开发环境实现资源服务的耐久语义。上传由服务端创建或验证的稳定 `session_id` 标识；每个分段只能从服务端已确认的 offset 继续追加。完成上传时，在同一 SQLite 事务内验证准确长度、SHA-256 content hash 和二进制 magic MIME，再插入资源对象或返回同租户的既有相同内容资源。

资源与文档分离：完成上传本身不会让对象可被下载或写进某份 Document。只有经过对象级 writer 权限校验后，AssetId 才能附加到 Document；下载同时校验短期随机凭据、租户、文档 reader 身份和该文档对资源的实际引用。AssetId 或 content hash 都不是授权凭据。

当前开发实现将已验证对象放在 SQLite BLOB，目的是证明 admission、dedupe、续传与授权的事务边界。浏览器在隔离 Asset Probe Worker 预检后发起上传，完成附加后以 `RegisterResource` Operation 写入 Canonical Document Resource Index；图片导入还会创建带 `AssetId` 的 Image 节点，并以 document-scoped 短期下载凭据恢复其 Canvas 投影。生产部署可将 object bytes 替换为对象存储键和签名 URL，但不得绕开此处的 MIME/hash 校验或 document-scoped 授权检查。EXIF/ICC 规范化、完整隔离解码、客户端 OPFS 缓存、字体解析和字体节点引用仍是后续 Phase 1 工作。
