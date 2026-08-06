# ADR 0019：Asset Service 的上传与下载边界

状态：已采纳（Phase 1.6 基础）

`crates/asset-service` 为单客户端开发环境实现资源服务的耐久语义。上传由服务端创建或验证的稳定 `session_id` 标识；每个分段只能从服务端已确认的 offset 继续追加。完成上传时，在同一 SQLite 事务内验证准确长度、SHA-256 content hash 和二进制 magic MIME，再插入资源元数据或返回同租户的既有相同内容资源。

资源与文档分离：完成上传本身不会让对象可被下载或写进某份 Document。只有经过对象级 writer 权限校验后，AssetId 才能附加到 Document；下载同时校验短期随机凭据、租户、文档 reader 身份和该文档对资源的实际引用。AssetId 或 content hash 都不是授权凭据。

已验证字节现在由 `AssetObjectStore` 承载；默认 `LocalFileObjectStore` 在 SQLite 数据库同级的 `.objects` 目录中，以租户和 content hash 为键原子落盘。对象写入并同步成功后，才会插入 Asset 元数据；若对象写入短暂失败，保留 upload session 以便同一 offset 继续完成。SQLite 仅保存上传状态、对象键、元数据、ACL、Document 附加关系和短期凭据。旧开发库中的 BLOB 在首次打开时迁移到文件对象存储并清空，保留空列仅为兼容旧 schema。

对象写入成功而随后 Asset metadata 插入、session 删除或事务提交失败时，服务立即补偿删除尚无 AssetRecord 引用的对象，并保留 upload session 供安全重试；故障注入测试覆盖这一顺序。已登记但未附加的对象则进入持久清理队列，不能把这两种失败路径混为一谈。

浏览器在隔离 Asset Probe Worker 预检后发起上传，完成附加后以 `RegisterResource` Operation 写入 Canonical Document Resource Index；图片导入还会创建带 `AssetId` 的 Image 节点，并以 document-scoped 短期下载凭据恢复其 Canvas 投影。生产部署可提供 S3-compatible `AssetObjectStore`，但不得绕开此处的 MIME/hash 校验或 document-scoped 授权检查。

字体上传除 MIME magic 外还必须通过 `ttf-parser` 的 face/table 解析：集合 face 数、glyph 数和 variation axis 数均有固定上限。解析失败的字体不会取得 `AssetId`，因此不能进入 Canonical Text 的 `FontReference`。

服务还将上传开始/完成、拒绝、去重、附加、凭据签发和实际下载写入 tenant-scoped 的耐久审计索引。拒绝记录只含分类结果（例如 `content_hash_mismatch` 或 `font_invalid`），不暴露请求内容。事件只包含可信租户、可选 Document/Asset 标识、动作、结果和时间；不含文件名、字节、URL、session 或 grant token。`GET /v1/assets/audit-events?afterSequence=&limit=` 仅按请求者租户返回元数据，并使用单调 sequence 游标和最多 500 条的页大小完成可重试的增量投递。过期 grant 可通过维护入口安全、幂等地清除。

维护任务会删除过期 grant 与未完成 upload；超过保留期、且从未附加到 Document 的 Asset 元数据会先在同一 SQLite 事务内转入持久 `object_cleanup_queue`，再由可重复执行的队列 drain 删除对象字节。drain 在 SQLite 写事务中重新检查同一 `(tenant, content hash)` 是否已被重传引用；若已恢复引用，只移除过期队列项，不删除对象。对象存储暂时失败时队列项保留，后续重试不会删除仍被 Document 引用的资源。Asset API 在启动时运行一次维护，再按 `MAKEFIGMA_ASSET_MAINTENANCE_INTERVAL_SECONDS` 重复；三个时长均可由同名的 `MAX_UPLOAD_AGE` 与 `MAX_UNATTACHED_ASSET_AGE` 秒数环境变量安全配置。
