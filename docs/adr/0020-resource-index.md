# ADR 0020：Canonical Document Resource Index

状态：已采纳（Phase 1.5）

Document 不保存图片或字体的原始字节，而是在 `editor-core` 的有序 Resource Index 中保存 `AssetId`、SHA-256 content hash、MIME、字节长度及可选像素尺寸。该 Index 参与 Canonical Hash，因此浏览器缓存、GPU Atlas 或对象存储的清理都不能改变文档语义。

Index 使用 Protobuf `ResourceIndexEntry` 作为 durable Snapshot 的唯一 wire 表达；字段号 5、6 追加保存图片宽高。WASM JSON Snapshot v12 写入同一份 metadata，v13 追加 `SceneNode.asset_id`，v14 追加 TextProperties（其中 FontReference 回指同一 Index），v1–v11 缺失 Index 时迁移为空集合。Document Service 在恢复时验证 AssetId、content hash、MIME、长度与宽高 presence，再计算完整 Canonical Hash。

`RegisterResource` 是 Resource Index 的唯一 Operation 入口。它只在 Asset Service 已完成内容验证、并将 AssetId 附加到同一 Document 后提交；Operation 不含原始字节，并参与 payload hash、Document Service reducer、Undo/Redo、远端恢复与 Canonical Hash。浏览器导入入口先在独立 Asset Probe Worker 检查 MIME/尺寸，再按服务端 offset 续传并完成该注册。

注册不等于可绘制或可下载。`Image` 节点以 Canonical `AssetId` 引用已注册图片；浏览器导入后创建该节点，刷新时向 Asset Service 获取 document-scoped 短期下载凭据并重建 Canvas 图片投影。Canonical FontReference 同样以已注册字体为目标；Worker 优先从 OPFS 缓存获取字节、再按短期凭据下载，使用 FontFace 注册到运行时字体集，并在加载失败时保持明确的系统字体降级。完整隔离解码与字形塑形仍在后续 Phase 1；缓存仅是可再生投影。
