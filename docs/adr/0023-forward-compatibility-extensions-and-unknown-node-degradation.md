# ADR 0023：未知数据保留（extensions）与未知 NodeKind 的降级契约

状态：已采纳（Phase 2 收尾）

## 背景

Phase 2 冻结了 8 种 NodeKind 与其属性。Phase 3+ 会追加新的 NodeKind 与新的节点级
payload。一个尚未升级的客户端必然会遇到两类它不认识的数据：

1. 已认识的节点上挂着它不认识的**附加字段**（前向兼容 payload）。
2. 它完全不认识的**节点类型**（未来 NodeKind）。

`docs/phase2-remediation-plan.md` 的 P0-2、P0-3 要求这两类情况都必须有确定的、
可测试的行为，且不得把未知节点静默改写为 Rectangle（验收场景 15）。

## 决定

### 1. 节点级 `extensions`：逐字节保留（P0-2）

- `SceneNode` 追加 `map<string, bytes> extensions = 38;`（append-only，下一个可用字段号）。
- Rust `Node` 增加 `extensions: BTreeMap<String, Vec<u8>>`。选 `BTreeMap` 而非 `HashMap`
  是为了让键序确定，从而 Canonical Hash 可复现。
- `extensions` 进入 `hash_node`，但**空 map 不写入哈希输入**，保证 Phase 1/2 存量
  文档的 Canonical Hash 不变（与 fills/strokes 等既有空集合跳过规则一致）。
- 四条序列化路径全部往返该字段：`document-codec`、`document-service` 的
  `operation_adapter` 与 `core_snapshot_adapter`、`editor-wasm` 的浏览器投影。
- 浏览器投影上 `extensions` 只读透传（`#[serde(default)]`），不进入 Inspector、不可编辑。
  一个 Phase 3 节点因此能透过旧客户端的 Snapshot 保存 / Operation 重放 / Undo-Redo
  往返而**逐字节不被改写**。

### 2. Page / Document 级 `extensions`：声明为保留字段（P0-2）

`PageChunk.extensions = 5` 与 `DocumentSnapshot.extensions = 8` 在 wire 契约中保留，
但**当前不接通到 Core 的 `Page` / `Document` 类型**：codec 写出时恒为
`Default::default()`，读入时忽略。理由：

- Phase 3 的前向兼容需求集中在**节点**（新 NodeKind、新节点属性），Page/Document 级
  尚无已知的未知 payload 来源。
- 提前把两个空 map 接通到 Core 类型只会增加 Hash 输入面与迁移风险，没有对应收益。

当 Phase 3 出现真实的 Page/Document 级前向兼容需求时，按与节点级相同的模式接通
（BTreeMap + 空集合跳过哈希），并在此 ADR 追加记录。字段号已保留，届时无需破坏性变更。

### 3. 未知 NodeKind：整体拒绝 + 可区分的只读降级（P0-3，方案 A）

采纳 `phase2-remediation-plan.md` P0-3 的方案 A（保持整体拒绝，工作量小），而非方案 B
（引入 `NodeKind::Unknown` 占位节点）。方案 B 需要在渲染、命中、Inspector、往返各层
新增一条 Unknown 通路，其复杂度不属于 Phase 2 收尾范围。

契约细化如下：

- codec 的 `node_from_proto` 对**正值但不在已知集合内**的 `kind`（即未来 NodeKind，
  如 9、10）返回**可区分**的 `SnapshotError::UnsupportedFutureNode`，而非泛化的
  `Invalid`。`NODE_KIND_UNSPECIFIED = 0` 仍返回 `Invalid`（它是真正的非法值，不是
  未来版本）。
- `editor-wasm` 的 `load_snapshot_protobuf` 把该错误映射为可区分的错误串
  `DOCUMENT_REQUIRES_NEWER_CLIENT`，其余快照错误仍为 `INVALID_CORE_SNAPSHOT`。
- 关键不变量：拒绝时 `self.document` **不被替换**（`?` 早退），因此不崩溃、不改写、
  不产生任何 Operation——旧文档原样保留。
- 前端把 `DOCUMENT_REQUIRES_NEWER_CLIENT` 分类为**新的**、不可重试的 `EditorErrorCode`
  `UNSUPPORTED_DOCUMENT_VERSION`，向用户呈现"文档包含更新版本的节点，当前客户端进入
  只读"而非泛化的"数据损坏"，与真正的 `CORRUPT_DATA` 区分开。

## 后果

- 未来节点在旧客户端上**要么逐字节保留（extensions），要么被整体拒绝并进入清晰的只读
  提示（未知 NodeKind）**，两条路径都不会静默改写数据。
- 新增错误码 `UNSUPPORTED_DOCUMENT_VERSION` 与 `SnapshotError::UnsupportedFutureNode`
  是 append-only 的公共契约面，删除需走 `reserved` 流程。
- Page/Document 级 extensions 仍是"已保留、未接通"，任何依赖其往返的 Phase 3 工作
  必须先回到本 ADR 补齐接通决策。
