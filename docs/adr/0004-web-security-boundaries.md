# ADR 0004：Web 信任边界与隔离响应头

状态：已采纳（Phase 0 基线）

## 决定

- 所有 Web 响应统一发送 `COOP: same-origin`、`COEP: require-corp` 与 `CORP: same-origin`；主页面因此进入 `crossOriginIsolated`，但编辑器在 SharedArrayBuffer 不可用时仍使用 Transferable 消息正常工作。
- CSP 默认只允许同源脚本、样式、图片、字体、Worker 和 WASM；页面禁止 object、嵌入、跨站表单与任意第三方脚本。开发环境仅额外允许 HMR 所需的 `ws:`、`wss:`、`unsafe-eval`，以及本机 Rust Document API `http://127.0.0.1:8788`；生产环境不继承该白名单。
- 默认关闭相机、麦克风、地理位置、支付与 USB 权限；同时固定 `nosniff`、无 Referrer 与拒绝 iframe 嵌入。
- `/plugin-sandbox` 提供最小的插件 UI 隔离验证页：iframe 只有 `sandbox="allow-scripts"`，故意不含 `allow-same-origin`、网络、表单、弹窗、下载或导航权限。`srcdoc` 内自身使用 deny-by-default CSP；它不暴露 Host API、消息 Capability、Document、存储或上传能力。
- 当前本地原型没有服务端身份、对象或租户，因此不声明服务端 AuthZ 已完成。Core 已提供由可信 Principal 覆盖客户端 actor、按 tenant/document/editor 验证 Operation 的 Contract Harness，以及不含未可信 actor 与 payload 的版本化授权审计事件；Asset Probe 同样只生成不含文件内容、文件名或请求 ID 的结构化事件。未来 API、协同和插件服务必须在独立服务端边界执行该契约、将事件写入受控审计 sink 并施加资源配额，不能由 Next.js 或客户端字段代替。

## 后果

任意引入跨源字体、图片、插件资源或分析脚本前，必须先为该资源设置与 COEP 兼容的 CORS/CORP 响应，并更新本 ADR 与 CSP。未通过该流程的资源会被浏览器阻止，而不是静默降低隔离级别。
