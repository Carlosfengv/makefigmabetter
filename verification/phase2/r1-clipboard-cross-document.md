# Phase 2 R1 验收记录：版本化节点剪贴板（首个实现切片）

- 日期：2026-08-09
- 状态：自动与真实浏览器候选通过；**R1 仍在实施中**。
- 覆盖源码：`src/lib/editor-clipboard.ts`、`src/lib/transaction-batch.ts`、`src/workers/editor.worker.ts`、`src/components/editor/editor-shell.tsx`。

## 已验证

1. `makefigma-node-clipboard-v1` 包含 schema version、来源 document/page、root IDs、parent-before-child 投影、资源内容 Hash 和 payload SHA-256；不携带资源原始字节。
2. 解码在进入 Worker 前验证 schema、Hash、总字节、节点数、最大深度、父子结构和资源引用；Worker 在粘贴前重复校验，并确认目标 Resource Index 的 ID 和内容 Hash。
3. 真实浏览器跨标签页、跨文档的无资源复制粘贴：来源文档选择 `Signal`，目标文档节点数从 `4` 变为 `5`，并生成新 Canonical Hash；控制台 `0` error。候选产物：
   - `output/playwright/phase2-clipboard-target-before.txt`
   - `output/playwright/phase2-clipboard-target-after.txt`
   - `output/playwright/phase2-cross-document-clipboard.png`
4. 真实浏览器跨文档的未授权图片粘贴：源 `Image cover crop` 载荷包含 AssetId 和内容 Hash；目标文档的 Resource Index 为空，粘贴前后均为 `0 assets / 4 nodes`，Canonical Hash 相同，控制台 `0` error。候选产物：
   - `output/playwright/phase2-clipboard-unauthorized-before.txt`
   - `output/playwright/phase2-clipboard-unauthorized-after.txt`
   - `output/playwright/phase2-cross-document-clipboard-unauthorized.png`
5. Professional Composite 浏览器候选：选择 `Polygon` 后执行 ⌘C/⌘V，节点数从 `19` 变为 `20`，Canonical Hash 从 `c21da51d7882…` 变为 `6ab16a68a84c…`，控制台 `0` error；重新打开固定夹具后恢复基线。剪贴板投影验证已覆盖当前全部 NodeKind，包括 Polygon、Star、Vector、BooleanOperation 和 Slice。
6. Professional Composite 的嵌套 Auto Layout 回归：选择 `Auto layout level 1` 后执行 ⌘C/⌘V，复制目标会解析为源容器的同级层；节点数从 `19` 变为 `25`，Canonical Hash 从 `07a7815d6a29…` 变为 `584868abbed4…`，控制台 `0` error。核心还覆盖固定尺寸子层溢出时不应被误判为 Fill 冲突，以及同级嵌套布局子树的单事务粘贴。
7. Professional Composite 的 BooleanOperation 子树回归：选择 `Boolean union` 后执行 ⌘C/⌘V，Boolean 容器及两个 operand 子层一并复制，节点数从 `19` 变为 `22`，Canonical Hash 从 `07a7815d6a29…` 变为 `76cb0515b828…`，控制台 `0` error。
8. 自动化跨 Page 粘贴：带 Frame / Group / Image 的完整子树复制到明确的另一 Page 后，所有新节点归属目标 Page，且根、子节点与孙节点的父子关系均保持正确重映射。
9. 真实浏览器跨文档的已授权图片粘贴：Professional Composite 源文档复制导入图片到当前 schema 的空白目标文档；目标资源授权接口返回 `201 Created`，回滚标记提交返回 `204 No Content`，Document API 操作保存返回 `200 OK`。画布从 `4 nodes / 0 assets` 变为 `5 nodes / 1 assets`，图片图层可见且无编辑器告警。随后 ⌘Z 回到 `4 nodes / 0 assets`，⌘⇧Z 恢复为 `5 nodes / 1 assets`。
10. 真实浏览器键盘 Cut：源文档的已选导入图片执行 ⌘X 后，系统/本地回退剪贴板先完成写入，画布才由 `20 nodes / 4 assets` 变为 `19 nodes / 4 assets`；⌘Z 后精确恢复到 `20 nodes / 4 assets`。该路径没有留下半完成节点或丢失资源索引。
11. 真实浏览器断线重放：目标文档离线创建 Rectangle 后保留本地状态和 Canonical Hash，Worker 显示“offline · recovery resumes when network returns”而不进入安全模式；网络恢复后 Worker 自动重建，待发送 Document API 操作返回 `200 OK`，状态收敛为“remote changes saved”。目录版本/最近打开时间这类非关键元数据在离线时不再显示保存失败告警。
12. 隔离的服务恢复 Hash 矩阵：以临时 SQLite、临时 Document API 和 3012 Web 进程运行“在线编辑→离线编辑→页面重载→Document API 重启→重放”。恢复后浏览器与服务端均为 revision `2`，Canonical Hash 均为 `97155e7287909ddd86ff30ede7fff2d1727898667e315c8d6f5f5edcb4f123f2`，逐字节相同。产物：`output/playwright/phase1-operation-recovery/20260809T042201Z/operation-recovery-summary.json`。
13. 跨文档资源服务恢复：Asset API 的持久化 HTTP 测试覆盖“源文档绑定→目标文档 `attach-from-document`（201）→提交回滚标记（204）→服务重启→目标文档下载授权与读取”。重启后仍能读回原始资源字节，证明已提交的跨文档 Resource Index 附件不依赖进程内状态。
14. 真实浏览器跨 Page 完整子树粘贴：在 Page 1 选择 `Professional composite`，创建并切换到空的 Page 2 后粘贴。全局节点数由 `19` 变为 `38`，Page 2 中只有一份被复制的根及其后代，资源仍为 `3 assets`。一次撤销回到 `19 nodes`，一次重做恢复为 `38 nodes`，验证了目标 Page 归属与单事务 Undo/Redo。

## 自动验证

- `pnpm test -- workspace-store worker-recovery editor-clipboard asset-api-transport protocol-operation-codec transaction-batch`：627 项通过，覆盖当前 NodeKind 白名单、Polygon/Star/Vector/Slice 捕获粘贴、Auto Layout Relative-v1 归一化、跨 Page 子树重归属、外部剪贴板的无字节资源元数据、旧版 v1 剪贴板兼容、源 schema 不高于目标最高 schema 的兼容规则、源到目标文档授权请求与回滚、离线 Worker 恢复不消耗崩溃预算、目录元数据静默离线保存，以及注册资源先于图片创建的 Protobuf 操作顺序。
- `cargo test -p makefigma-asset-service cross_document_attachment_requires_source_membership_and_destination_write_access`、`cargo test -p makefigma-asset-api durable_http_reopen_retains_authorized_clipboard_asset_delivery`、`cargo test -p editor-wasm concrete_batch_crosses_the_bridge_as_one_history_revision`：均通过；分别验证源文档可读、源已附加资源和目标可写三项条件与补偿语义，已提交跨文档附件穿过 Asset API 重启后的下载能力，以及资源注册、图片创建和 Undo 同属一笔 Core 历史事务。
- `cargo test -p editor-core auto_layout_allows_fixed_children_to_overflow_without_a_fill_constraint`、`cargo test -p editor-wasm nested_auto_layout_subtree_can_be_pasted_beside_its_source_frame`：均通过。
- `pnpm lint`、`pnpm check:compatibility`、`pnpm check:boundaries`、`pnpm build`：通过。

## R1 结论

- R1 已关闭：剪贴板携带经 Hash 认证的无字节资源元数据；Asset Service 以“源可读 + 源已附加 + 目标可写”约束授权附加；Worker 将 Resource Index 注册与节点创建合并为同一 Core 事务。Core 失败只补偿本次粘贴创建的目标授权，成功后消费回滚标记。真实浏览器、单元测试与服务恢复矩阵已覆盖跨文档、跨 Page、资源、Undo/Redo 及断线重放。
