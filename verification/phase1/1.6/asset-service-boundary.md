# Phase 1.6：资源服务耐久边界候选记录

状态：本地自动验证通过；不是 Phase 1 完成声明。

## 已验证边界

- 分段上传只接受服务端确认 offset；完成时在 SQLite 事务边界验证长度、SHA-256、magic MIME 和
  字体 table/face/variation 预算；
- `AssetObjectStore` 是可替换的内容寻址对象边界。默认文件实现先 fsync 后原子改名，元数据无法在
  对象写入失败时可见；metadata 写入失败会补偿删除无引用对象；
- Attachment、reader/writer ACL 与短期下载 grant 在服务端执行。资源 ID 或 hash 不构成下载授权；
- 未附加资源经持久队列清理；drain 在同一 SQLite 写窗口重新确认 hash 尚未重新引用，避免删除重传
  的对象；
- 结构化审计事件已耐久写入，并可通过
  `GET /v1/assets/audit-events?afterSequence=&limit=` 以 tenant-scoped、最多 500 条的 sequence
  游标分页读取。响应不含文件名、字节、session 或 grant token。

## 自动证据

```sh
cargo test -p makefigma-asset-service -p makefigma-asset-api
```

覆盖恢复后下载、去重、伪造 hash/MIME、越权、过期 grant、对象写入/metadata 失败、清理竞态、
定时维护配置和审计 HTTP 分页。2026-08-05 的本机 Asset API 已重启到包含审计端点的二进制，
`/health` 与空游标审计请求均成功。

## 尚未构成 PASS 的项目

该证据限于单客户端 SQLite/本地对象存储。生产对象存储适配器、跨机器重试投递、B1–B4 浏览器
导入/取消验收与独立缺陷审计仍是 Phase 1 Gate 的未完成项。
