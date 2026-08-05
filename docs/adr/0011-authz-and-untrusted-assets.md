# ADR 0011：对象级 AuthZ 与不可信资源准入契约

状态：已采纳（Phase 0 Contract Harness）

## 决定

- 服务端从认证会话构建可信 `Principal` 与 `DocumentPolicy`；客户端 Envelope 中的 actor 不可信，授权成功后必须由 Principal 的 actor 覆盖。
- 写入仅在 Principal、Policy 与已加载 Document 同时满足同租户、同 Document、编辑授权时才可进入 `submit_operation`。策略与当前 Document 不匹配、跨租户、跨文档和无授权均不修改 Document。
- 不可信资源必须在独立解析/解码器确认 MIME 后才可准入。声明 MIME 与检测 MIME 必须一致；Raster 必须由隔离头探测器给出宽高，并在实际解码/Canvas/GPU 分配前受 16,384 单边与 256 Mi 像素限制。原图保持为受控资产；若其完整 RGBA8 工作位图超过 256 MiB，Worker 只为交互渲染生成受限代理。SVG 受大小上限限制，必须以 SVG 根元素开始（允许 BOM 与 XML 声明），并拒绝 script、事件处理器、foreignObject/iframe/object/embed、style、动画、DTD/Entity 和非本地资源引用；`href` 与 `url(...)` 仅允许同一文档的 `#fragment`。在将字符串交给未来 XML 解析器前，契约还以不创建 DOM 的 token walk 限制实际 UTF-8 源大小为 1 MiB、元素数为 20,000、嵌套为 64 层；畸形标签或不匹配闭合标签同样拒绝。
- AuthZ 与资源拒绝使用结构化错误，而非把未经验证的输入交给 DOM、Canvas、Snapshot 或 Document Reducer。Worker 到 UI 的错误响应固定为错误码、脱敏提示、是否可重试、文档 revision 与本地诊断序号；原始异常、路径、操作载荷和用户输入不得跨越该边界。

## 当前边界

当前 Web 原型没有认证服务、tenant 数据库、真实上传或插件运行时。它已有只负责有界 MIME/头信息识别的 Asset Probe Worker：SVG 在严格 UTF-8 与 DOM-free 预检后准入，PNG/JPEG/WebP 与 WOFF/WOFF2/TTF/OTF 只读取有限签名/头信息；取消可以阻止尚未开始的探测并抑制已取消请求的结果。资源 Worker 会随结果产生 v1 脱敏审计事件，不包含文件名、声明 MIME、SVG 源、路径或请求 ID；Rust 授权契约也可输出 v1 审计事件，记录可信 principal、目标、revision 与枚举结果而不记录未可信 actor 或 Operation payload。两者只是供未来受认证服务端审计 sink 消费的结构，当前不会写入 Document 或声称已经投递。`/plugin-sandbox` 还提供无 Host Capability 的 opaque-origin iframe 基线，但它不是插件运行时或权限模型。该 Worker 不执行图片或字体完整解析/解码，也没有把结果接入 Document、Canvas 或上传路径。本 ADR 提供的是未来 Rust 服务端、资源服务和 Contract Test 的可执行 Core/TypeScript 契约，不声明客户端已承担或完成服务端授权。

## 后果

引入 API、WebSocket、上传或插件前，必须把该契约接到已认证的服务端会话和隔离的完整解析进程，并新增审计事件、速率/资源配额、跨租户 Asset 与 sandboxed plugin UI 的端到端测试。该预检不是 XML/SVG 渲染器；Raster 限制不替代隔离解码、可中断解码、字体表限制或 GPU 资源记账。Next Route Handler 或客户端字段不得成为授权事实来源。
