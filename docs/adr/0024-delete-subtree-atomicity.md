# ADR 0024：子树删除的原子性契约（服务端不变量）

状态：已采纳（Phase 2 收尾）

## 背景

删除一个容器（Frame / Group / Section）在语义上必须连同其**全部后代**一起消失，且这
一整体要么全部提交、要么全部回滚。当前的实现路径是：

- 前端 `src/lib/transaction-batch.ts` 的 `delete` 分支把一次容器删除**展开**为子节点
  优先（child-first）的多条 `DeleteNode` 命令，放进**同一个事务**提交。
- editor-core 的 `Command::Delete`（`crates/editor-core/src/lib.rs`）在删除一个仍有子
  节点的节点时返回 `NodeHasChildren` 而拒绝。

因此"子树删除的原子性"目前是**顺带成立**的：它依赖 TS 层的排序正确 + Core 的
child-first 拒绝 + 事务原子性三者叠加，而没有一条以"容器删除必须携带完整后代"为名的、
可独立测试的 Core/服务级不变量。`docs/phase2-remediation-plan.md` 的 P1-4 要求消除这一
"原子性由 TS 排序保证"的隐性依赖。

方案二选一：

- **(a)** 维持现状的 TS 层展开，但在 document-service 增加一条服务端校验——"同一事务内
  容器删除必须携带其完整后代"——并补回归测试；
- **(b)** 在 Core 新增 `DeleteSubtree` 具名命令，TS 层退化为单命令。

## 决定

采纳 **方案 (a)**。改动面最小，且把校验放在信任边界（服务端）上，对任何来源的批次
（含绕过前端的恶意/缺陷批次）都成立，而不是把不变量的正确性寄托在客户端排序上。

具体实现（`crates/document-service/src/core_snapshot_adapter.rs`）：

- 在 `CoreOperationReducer::apply` 内、把命令提交给 Core **之前**，调用
  `validate_delete_subtree_completeness(&document, &commands)`。此时手上持有的是
  **变更前**的 `Document`，可以据此枚举每个节点的父节点。
- 校验逻辑：
  1. 收集本批次中所有 `Delete { id }` 的目标集合 `deleted`；批次不含删除则直接放行。
  2. 计算每个节点的**批次后有效父节点**：以变更前父节点为基线，再让本批次的
     `SetNodeParent` 覆盖之。这样"被 reparent 移出待删子树"的后代不会被误判。
  3. 若存在任一节点其**有效父节点 ∈ `deleted`** 而它**自身 ∉ `deleted`**，返回
     `ReducerRejected`——即"删了容器却漏删某个后代"。
- 拒绝发生在任何快照写入之前，因此文档的 `accepted_revision` 与全部节点原样保留。

### 与 Group 自动消解的相互作用

Core 在一个 Group 的**最后一个子节点**被删除时会**自动消解**该 Group。因此一条对
"Group 容器 + 其唯一子节点"的显式双删批次会让针对该 Group 的第二条 `Delete` 落到一个
已消失的节点上。这是既有行为，`transaction-batch.ts` 已经通过"占用中的 Group 从
`coreIds` 中过滤掉"来规避。本 ADR 的服务端校验是**与 kind 无关**的纯结构检查，只回答
"后代是否被完整带走"，不复制也不干预 Group 消解逻辑；两者互不耦合。

## 后果

- "容器删除必须携带完整后代"成为一条**具名、可独立测试**的服务端不变量，不再只是 TS 层
  排序的隐性副产品。回归测试覆盖三种情形：漏删直接子节点被拒、漏删更深层后代被拒、
  完整 child-first 子树删除被接受；并有一条把后代 reparent 出待删子树后再删容器被接受的
  用例，锁定"有效父节点"语义。
- 未选择方案 (b)：不引入 `DeleteSubtree` 具名命令，避免在 Core 的命令集、Undo/Redo、
  Canonical Hash、protobuf 线格式各层新增一条通路。若未来出现需要 Core 层原生表达子树
  删除的需求（例如为了单命令的 Hash 粒度），再回到本 ADR 追加迁移决策。
- 服务端校验拒绝时统一映射为 `ServiceError::ReducerRejected`（对外
  `INVALID_ENVELOPE` / "Operation could not be applied."），与其他不可应用的批次同类，
  不额外暴露文档结构细节。
