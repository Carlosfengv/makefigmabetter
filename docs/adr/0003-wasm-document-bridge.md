# ADR 0003：Rust/WASM 文档桥接

状态：已采纳（Phase 0 / Phase 1 过渡）

## 决定

- `editor-core` 保持平台无关；`editor-wasm` 使用 `wasm-bindgen` 将其版本化 Transaction API 暴露给浏览器。
- Engine Worker 在启动时加载实际的 WASM 模块并验证 `engine_semantics_version`；wasm-bindgen 的模块级初始化由单例 Promise 串行化，避免 `init` 与紧随其后的 `hydrate` 并发重建 linear memory。每次 hydration 仍创建独立的 `DocumentEngine`，只有最后一个 load sequence 可以发布投影。
- Canvas 2D 仍由 Worker 管理。WASM 此阶段仅验证文档 Core 的浏览器装载，不承担逐帧渲染。
- `pnpm wasm:build` 会先构建 `wasm32-unknown-unknown` 产物，再生成浏览器 JS glue 与类型定义。

## 当前边界

Worker 会明确报告「Rust/WASM bridge ready」或「TypeScript document prototype」。当 bridge 就绪后，CreateNode、Rename、几何更新、基础外观（填充、描边、描边宽度、透明度、圆角、可见性、锁定）、Duplicate、多节点 Delete 和单次多节点拖动会先由 Rust Reducer 准入，只有成功后才更新画布投影。连续 Create、Update、Delete、Duplicate 可先在 Worker 解析为完整、确定的 Core 批次，再作为版本化 Operation Envelope 以一个 revision 和一个 HistoryItem 提交给 Rust；Duplicate 解析为带新 UUID 的 Create，不能保留 Worker 本地副本。选择、视口和控制命令不能混入该批次。这些 LocalUser 事务的 Undo/Redo 也由 Rust HistoryItem 驱动，并以当前 Core snapshot 刷新画布投影。transaction 和 Operation 分别有幂等键；重复的已接受批次或 Operation 不会生成第二个 revision，Core 会输出不含 UI/历史缓存的 canonical SHA-256 hash。单次事务、Undo/Redo 和两类去重缓存都有数量与估算字节上限，超过预算以 `RESOURCE_LIMIT` 拒绝；WASM 公开相应统计给 Worker。Snapshot 保存 hash 与 retired ID tombstone，加载时会校验 hash，保证删除后的 ID 不会在刷新后复用。主线程的串行持久化队列会先追加已接受的 Core 操作，再将带 SHA-256 内容哈希的不可变 Snapshot 写入 OPFS、关闭并复读校验，最后在同一 IndexedDB transaction 中切换 active/previous Manifest 指针并清除该 snapshot 已覆盖的 Journal。OPFS 不可用时回退到内联 IndexedDB Snapshot；启动会校验 active，失败则自动加载 previous 并提示恢复状态。启动还会申请持久化存储、检查可用空间；空间不足会拒绝新的 Snapshot 而不删除旧版本。支持 Web Locks 时，Owner 是唯一可写入 Journal、Manifest 与 Snapshot 的标签页；其他标签页只读、接收 Owner 完成持久化后的快照，并可通过带优先级的 BroadcastChannel 编辑意图请求交接。没有 Web Locks 时保留本地编辑降级，但不宣称多标签页一致性。rotation 与 text 已进入 Core，旧 presentation sidecar 只在迁移时读取；完整跨浏览器协调和服务端 pending Operation Ack 仍在后续阶段。前端保留的即时画布状态是投影而非第二套产品 API；这不是最终架构，而是可验证的迁移阶段。
