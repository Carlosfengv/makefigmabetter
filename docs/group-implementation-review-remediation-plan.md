# Group 实现完整修复方案

> 状态：Draft，待技术评审与排期
> 编制日期：2026-08-08
> 适用基线：当前本地工作区
> 范围：Group 的对象定义、Canonical 数据、Snapshot、事务、协作重放、画布交互、Layers、Inspector、快捷键与测试
> 关联文档：`docs/group-layer-priority-remediation-plan.md` 记录早期四项 P0；本文覆盖完整审查结果并作为后续实施主计划
> 本文只定义修复方案，不包含产品代码修改。

## 1. 目标与结论

当前实现已经具备 Group/Ungroup、单节点 Group、嵌套 Group、相对矩阵、子树复制和部分 Group Bounds 归一化能力，但 Group 语义仍同时分散在 Rust Core、TypeScript resolver、Worker 临时态和 React UI 中。结果是同一个 Group 在不同入口下可能得到不同的结构、Bounds、锁定和选择行为。

本次修复不按 UI 症状逐项打补丁，而是建立以下统一规则：

1. **Rust Core 是持久化 Group 语义的唯一权威**。任何事务、远端重放或 Snapshot 恢复完成后，都必须得到相同的合法文档。
2. **Group 没有独立布局盒**。它的局部 Bounds 始终由 direct children 派生；移动、缩放和旋转通过矩阵变换表达。
3. **结构操作必须原子化**。Group、Ungroup、Reparent、Layers 拖放、删除最后一个 child 和 Group Constraints 都只能整笔成功或整笔失败。
4. **无效中间状态不能成为持久状态**。空 Group、非容器 parent、父子跨 Page、循环、重复 sibling position 和不可用矩阵都必须在事务边界被拒绝。
5. **所有交互读取同一份解析结果**。渲染、命中、选框、Handles、尺寸标签、Inspector 和拖拽提交不得各自解释 `x/y/rotation` 与 `relativeTransform`。

实施完成后的目标不是“看起来接近 Figma”，而是让以下链路共享同一语义：

```text
UI Intent
  -> deterministic resolver
  -> one canonical transaction
  -> Core validate + normalize
  -> snapshot / history / remote replay
  -> one resolved scene projection
  -> canvas + layers + inspector
```

## 2. Figma 行为基线

本方案采用以下官方行为作为兼容基线：

| 能力 | Figma 语义 | 本项目目标 |
| --- | --- | --- |
| 创建 Group | 节点列表非空；不支持创建空 Group | 允许单节点 Group，事务结束时禁止空 Group |
| Group Bounds | 始终由内容决定，child 移动时自动收边 | Core 深度优先归一化 direct children |
| Group/Ungroup | Reparent 后保持所有 child 的绝对位置 | 使用世界矩阵换基，不写猜测性的 `x/y` |
| 层级 | 可嵌套 Group，可从 Layers 移入和移出 | 所有 drop 位置都解析 parent 与插入点 |
| 选择 | 默认先选父 Group，双击/Enter 每次深入一级 | 基于完整祖先路径逐级 drill-down |
| 锁定 | 锁定父 Group 会锁定全部后代 | 使用祖先继承的 effective lock |
| 快捷键 | macOS `⌘Delete`、Windows `Ctrl+Backspace` 可 Ungroup | 优先解析 Ungroup，普通 Delete 仍删除 |
| Constraints | 设置 Group Constraints 会作用到 children | 解析为 direct children 的具体更新，不在 Group 上存独立值 |

参考资料：

- [Figma：Groups 与 Frames 的区别](https://help.figma.com/hc/en-us/articles/360039832054-The-difference-between-frames-and-groups)
- [Figma Plugin API：GroupNode](https://developers.figma.com/docs/plugins/api/GroupNode/)
- [Figma Plugin API：`figma.group`](https://developers.figma.com/docs/plugins/api/properties/figma-group/)
- [Figma：选择图层和嵌套对象](https://help.figma.com/hc/en-us/articles/360040449873-Select-layers-and-objects)
- [Figma：锁定和解锁图层](https://help.figma.com/hc/en-us/articles/360041596573-Lock-and-unlock-layers)

## 3. 当前问题与优先级

| ID | 优先级 | 问题 | 主要风险 | 关闭该问题的工作包 |
| --- | --- | --- | --- | --- |
| G-01 | P0 | 嵌套 Group Snapshot 恢复依赖 UUID 排序，parent 可能晚于 child | 合法文档保存后无法重载 | WP1 |
| G-02 | P1 | Relative-v1 Group 收边只在部分 Worker 路径执行，Core 会跳过 | 远端操作、Inspector 或通用 Reparent 后 Bounds 过期 | WP2 |
| G-03 | P1 | Inspector 对 Group 直接写 `x/y/width/height/rotation` | 位置无效、只改外壳、children 不跟随 | WP3 |
| G-04 | P1 | Layers 拖放仅 center drop 能 Reparent；before/after 只 Reposition | 无法稳定移入、移出或跨容器精确排序 | WP4 |
| G-05 | P1 | `⌘Delete`/`Ctrl+Backspace` 被解析为 Delete | 与 Figma 冲突且可能误删整组 | WP5 |
| G-06 | P1 | Canonical 层级不变量不完整 | 可持久化空 Group，或把 child 放进 Rectangle | WP1、WP2 |
| G-07 | P1 | Group 的 lock 不向后代继承 | 锁定 Group 后仍可命中和编辑 child | WP5 |
| G-08 | P2 | 嵌套 Group 的深入选择会跳过层级；Marquee 无边界规则 | 选择模型与 Figma 不一致 | WP5 |
| G-09 | P2 | Group Constraints 被 Core 直接拒绝 | Inspector 能力缺失，行为与 Figma 不一致 | WP6 |

已有能力应保留，不纳入重复改造：

- Group 继续是非绘制、非裁剪的结构节点；
- 单节点 Group 和嵌套 Group 已允许；
- Group/Ungroup 已使用一个 Core batch，并返回 `selectionIds` 与 `affectedGroupIds`；
- Ungroup 已为 former children 分配新的 sibling position；
- Group 整体移动不会对子树重复叠加位移；
- 最后一个 child 离开后已有部分自动解组能力；
- Duplicate 会复制完整子树；
- TypeScript `normalizeGroupBounds` 已实现正确方向的矩阵换基，可作为 Core 实现的行为参考。

## 4. 目标对象模型与不变量

### 4.1 Group 的数据语义

现有扁平节点结构可以继续使用：child 通过 `parentId` 指向 Group，兄弟顺序由 `positionId` 决定。无需为 Group 增加重复的 `children[]` 字段。

Group 字段的权威关系定义如下：

| 字段 | 语义 |
| --- | --- |
| `id/pageId/parentId/positionId` | Canonical 结构与顺序 |
| `relativeTransform` | Relative-v1 下唯一权威的 parent-local 仿射变换 |
| `x/y/rotation` | Legacy 兼容输入或由矩阵投影得到的兼容字段，不得独立修改 Relative-v1 Group |
| `width/height` | Group local rectangle 的派生尺寸，由 direct children 归一化得到 |
| `visible/locked` | Group 自身状态；`locked` 对后代产生 effective lock |
| `constraints` | Group 自身始终为 `None`；UI 设置被解析为 children 的具体 Constraints 更新 |
| Fill/Stroke/Clip/Auto Layout | Group 不拥有这些 Frame 语义 |

### 4.2 事务结束时的 Document 不变量

新增统一的 `validate_document_invariants()`，在完整事务应用完成、Snapshot 恢复完成和服务端远端 batch 重放完成后调用。至少验证：

1. 每个 `parentId` 都存在，且 parent 与 child 位于同一 Page；
2. parent kind 只能是 `Frame | Group | Section`；
3. parent 图不存在循环，自身不能成为自身祖先；
4. 每个 Group 至少拥有一个 direct child；
5. `(pageId, parentId, positionId)` 在兄弟域中唯一；
6. `relativeTransform` 所有分量有限，需执行换基的矩阵可逆；
7. Group `width/height` 有限且与归一化后的 local content bounds 一致；
8. 资源、文本和 appearance 的既有节点约束仍然成立。

事务内部可以短暂出现“先建空 Group、再 Reparent child”的中间状态，但不得逐条调用终态验证。执行模型应为：

```text
clone current document
  -> apply every command to working copy
  -> normalize affected groups, deepest first
  -> dissolve empty groups
  -> validate final invariants
  -> commit revision/history/hash
```

任何一步失败，working copy 丢弃，revision、selection、history、pending operation 和 hash 均不改变。

### 4.3 统一几何规则

节点世界矩阵：

```text
world(node) = world(parent) × local(node)
```

保持世界位置的 Reparent：

```text
newLocal(node) = inverse(world(newParent)) × oldWorld(node)
```

Group 内容贴合算法：

1. 收集 direct children 的 local rectangle 四角；
2. 在 Group local space 中求联合 AABB `[left, top, right, bottom]`；
3. 更新 Group：`groupLocal' = groupLocal × T(left, top)`；
4. 更新每个 direct child：`childLocal' = T(-left, -top) × childLocal`；
5. 设置 `width = right - left`、`height = bottom - top`；
6. 内层 Group 先处理，再向外层祖先处理。

该换基保持所有 child 的 world transform 不变：

```text
world(parent) × groupLocal' × childLocal'
= world(parent) × groupLocal × childLocal
```

Legacy child 进入结构或矩阵编辑前，必须先物化为 parent-relative transform；禁止在同一次 Bounds 计算中混用世界 `x/y` 与 parent-local 矩阵。

## 5. 工作包明细

### WP0：先冻结失败用例和兼容基线

**目标**：在修改实现前，用最小 hostile fixtures 稳定复现九项问题。

**实施内容**：

1. 为每个问题先提交至少一个失败测试，测试名包含对应 ID，如 `G-01_nested_group_snapshot_parent_order`。
2. 冻结一个包含以下节点的文档 fixture：随机 UUID、三层 Group、旋转 Frame、单 child Group、locked Group、相邻 PositionId 和 legacy/relative 混合节点。
3. 记录旧 Snapshot fixture，后续必须由新版本 reader 成功恢复，防止修复拓扑排序时破坏历史数据。
4. 对现有行为生成 canonical hash、page hash、序列化字节和 world corners 基线；只允许在方案中明确列出的地方变化。

**主要文件**：

- `crates/editor-core/src/lib.rs` 测试模块
- `crates/document-codec/src/lib.rs` 测试模块与 fixtures
- `src/lib/*.test.ts`
- Group 相关 Playwright 测试目录

**通过标准**：修复前每项测试按预期失败，且失败原因与问题描述一致，而不是测试环境或随机时序造成。

### WP1：Snapshot 拓扑恢复与统一层级验证

**目标**：任何合法嵌套结构都能稳定保存、恢复；任何非法结构都不能进入持久文档。

#### 5.1.1 Snapshot 恢复

当前 `document_from_snapshot` 按 `PageChunk.nodes` 顺序逐个 `seed_node_on_page`，但 `ordered_nodes_on_page` 仅按 `(parentId, positionId, id)` 排序，不保证 parent 先于 child。随机 UUID 下，合法嵌套 Group 可能在恢复时被当成 missing parent。

修复为 codec 内的两阶段恢复：

1. 先解码 Page、`SceneNodeRef` 和 `canonical_node` 到临时表；
2. 校验 reference 与 canonical node 的 ID、Page、parent 和 position 一致；
3. 建立 `nodeId -> node` 与 parent 图；
4. 校验 missing parent、跨 Page、非法 parent kind、重复 ID/position 和 cycle；
5. 使用稳定拓扑顺序 seed：parent-before-child，同 parent 下按 `(positionId, nodeId)`；
6. 全部节点 seed 后附加 text/assets/retired IDs；
7. 执行最终 Document invariant validator，再验证 page hash 与 canonical hash。

不要直接改变 `ordered_nodes_on_page` 的语义来解决恢复顺序。该函数同时参与现有 page hash；直接改排序会让历史 Snapshot 的 `content_hash` 在新 reader 中不匹配。可新增私有 helper：

```rust
fn nodes_in_hydration_order(decoded: &[DecodedNode]) -> Result<Vec<NodeId>, SnapshotError>
```

Serializer 可以继续输出现有稳定顺序，因为新 reader 不再依赖输入顺序；如果未来改为 parent-first wire order，应使用独立 helper，且不得改变 page hash 的既有排序口径。

#### 5.1.2 Canonical 层级验证

将当前分散在 `validate_node_page`、Reparent 和删除逻辑中的校验收敛为两层：

- **Command-local preflight**：快速拒绝缺失节点、明显成环、跨 Page 和非法容器；
- **Transaction-final validation**：验证完整文档终态，包括非空 Group 与全局 sibling position 唯一性。

`CreateNode` 和 Snapshot seed 不得允许 Rectangle、Ellipse、Text、Image 或 Line 成为 parent。允许的容器必须由共享函数判定：

```rust
fn can_contain_children(kind: NodeKind) -> bool {
    matches!(kind, NodeKind::Frame | NodeKind::Group | NodeKind::Section)
}
```

#### 5.1.3 测试与验收

- child UUID 小于 parent UUID 的两层、三层 Group round-trip；
- Snapshot nodes 完全打乱后仍恢复成相同 canonical hash；
- missing parent、跨 Page、循环、Rectangle parent、空 Group 和重复 sibling position 均原子拒绝；
- 旧 Snapshot fixtures 仍能读取，page hash 不发生兼容性回归；
- Snapshot → Document → Snapshot → Document 后结构、world corners 与 canonical hash 一致。

### WP2：把 Group Bounds 归一化下沉到 Rust Core

**目标**：无论修改来自画布、Inspector、Layers、Undo/Redo、Snapshot 迁移还是远端重放，Group Bounds 都由 Core 得到同一结果。

#### 5.2.1 Core API

用新的矩阵算法替换 `refresh_group_bounds` 的 legacy 世界 AABB 回写和 Relative-v1 跳过分支。建议内部接口：

```rust
fn normalize_affected_groups(
    &mut self,
    affected: impl IntoIterator<Item = NodeId>,
) -> Result<Vec<NodeId>, CommandError>
```

实现要求：

1. 将 affected Group 去重并按层级深度降序排列；
2. direct child 在 Group local space 求四角，而不是读取 child world AABB 后写回 Group `x/y`；
3. 同时更新 Group local transform、Group size 和 direct children local transforms；
4. 每一步检查有限数与逆矩阵；失败时回滚整笔事务；
5. 归一化后继续处理外层 Group；
6. 输出实际变更的 Group IDs，供投影、选择几何和诊断使用；
7. 设定统一 epsilon，仅用于数值比较；最终写入值经过固定的数值规范化，避免不同平台漂移。

需要触发归一化的操作至少包括：

- Group、Ungroup；
- Reparent、Layers Drop；
- child move/resize/rotate；
- Inspector geometry update；
- Duplicate、Delete、Restore；
- Group Constraints fan-out 后导致的 child geometry 变化；
- Undo/Redo 和远端 operation batch。

#### 5.2.2 Worker 职责

`src/lib/scene-transform.ts` 中的 `normalizeGroupBounds` 不再作为持久语义权威：

- 可保留为 pointer move/resize 的无副作用 preview；
- preview 必须与 Core 共用同一组矩阵 fixture；
- Pointer Up 只能提交 intent 或具体 transform batch，最终结果以 Core projection 为准；
- 收到 Core 结果后，不得再次执行 TS normalize，避免二次换基；
- 若 preview 与 Core 结果超出 epsilon，记录诊断并立即使用 Core 结果纠正。

#### 5.2.3 测试与验收

- child 向左上、右下、穿过 Group 原点移动；
- 单 child、多 child、三层嵌套 Group；
- 旋转、非均匀缩放、斜切 parent；
- mixed legacy/relative 节点首次结构编辑；
- 未移动 sibling 的 world corners 逐点不变；
- 本地操作、远端重放、Undo/Redo 和保存重载得到相同 hash；
- Group local bounds 与 content bounds 在 epsilon 内一致，无空 Group 残留。

### WP3：Group 几何 Intent、Inspector 与画布控件

**目标**：X/Y/W/H/Rotation 对 Group 表达明确的子树变换，不再直接 patch 派生字段。

#### 5.3.1 新增结构化几何 Intent

推荐扩展 `EditorCommand`：

```ts
type TransformGroupCommand = {
  type: "transform-group";
  id: string;
  operation:
    | { kind: "translate"; worldDelta: { x: number; y: number } }
    | { kind: "resize"; width: number; height: number; anchor: ResizeAnchor; preserveRatio: boolean }
    | { kind: "rotate"; degrees: number; pivot: "center" | { worldX: number; worldY: number } };
};
```

如果现有通用 resize resolver 已能完整覆盖 Group，可复用现有 command，但必须满足相同的 Core 事务语义，不能降级为 `{x, y, width, height, rotation}` patch。

语义定义：

- **X/Y**：换算为 world translation，只更新 Group root 的 local matrix，children local matrices 不变；
- **W/H**：相对当前 Group local bounds 计算仿射 scale，并作用到可编辑的 selection subtree；之后由 Core 归一化；
- **Rotation**：围绕定义明确的 pivot 旋转 Group/subtree；避免同时写 matrix translation 与 legacy rotation；
- **零尺寸**：使用现有最小尺寸规则，任何导致非有限或不可逆矩阵的输入整笔拒绝；
- **locked/effectively locked**：除解锁操作外，所有几何 intent 拒绝。

#### 5.3.2 Inspector 读取与写入

当前单选 Inspector 对所有 node kind 共用 raw geometry fields。修复后：

1. Group Inspector 从 `ResolvedSelectionGeometry` 读取显示值；
2. 提交 X/Y/W/H/Rotation 时生成 Group transform intent；
3. 不再调用通用 `onUpdate({ width })` 等 raw patch；
4. 在 Group resize 尚未完成前，W/H 必须只读或隐藏，不能保留错误编辑入口；
5. Mixed Inspector 对包含 Group 的选区也必须通过通用 selection transform resolver，而不是逐节点 patch 派生字段。

#### 5.3.3 选框、Handles 与尺寸标签

新增或收敛为单一投影：

```ts
type ResolvedSelectionGeometry = {
  worldTransform: AffineMatrix;
  localBounds: { x: number; y: number; width: number; height: number };
  worldCorners: readonly [Point, Point, Point, Point];
  screenCorners: readonly [Point, Point, Point, Point];
  handlePoints: readonly Point[];
  sizeLabelAnchor: Point;
};
```

Selection overlay、Hover、8 个 Handles、旋转控件、Hit Test 和尺寸标签只消费该投影。旋转 Group 和旋转 parent 下，控件沿 Group local axes 布局，不能退化成 world AABB 的轴向 Handles。

#### 5.3.4 验收

- Inspector X/Y 移动整组且 children 不重复位移；
- W/H 等比与非等比缩放整组；Rotation 围绕同一 pivot；
- Pointer、Inspector、键盘三种入口结果一致；
- 旋转 Group、旋转 parent、嵌套 Group 和不同 zoom 下，内容、选框、Handles、标签一致；
- Pointer Up、保存重载、Undo/Redo 后无跳动或回弹。

### WP4：统一 Layers 拖放与结构事务

**目标**：每个 drop 位置都明确表达目标 parent 和 sibling insertion，不再把 Reparent 与 Reposition 分成互斥分支。

#### 5.4.1 Drop target 契约

把 Layers 回调统一为：

```ts
type LayerDropTarget = {
  parentId?: string;      // undefined 表示当前 Page root
  beforeId?: string;      // undefined 表示目标 parent 的末端
};
```

Virtual list 对三种落点都返回完整 target：

- `before`：target node 的 parent + target node ID；
- `after`：target node 的 parent + 下一个 sibling ID，或末端；
- `inside`：target node ID 作为 parent + 第一个/末端插入位置，按产品规范固定；
- root 空白区：`parentId = undefined` + root insertion。

#### 5.4.2 单一结构 resolver

新增 `resolveLayerDropTransaction(nodes, movingIds, target)`，一次完成：

1. 折叠 ancestor/descendant 重复选择，只移动 selection roots；
2. 验证目标 Page、容器 kind、cycle、effective lock 和 hidden/readonly 策略；
3. 记录每个 root 的 old world transform；
4. 计算新 parent-local transform，保持 world corners 不变；
5. 在目标兄弟域为所有 roots 分配精确、唯一且稳定的 PositionId；
6. 归一化 source 与 destination 两侧的 Group 祖先；
7. 删除因此变空的 Group，并继续向外处理可能产生的空 Group；
8. 保留移动 roots 的 selection；
9. 返回一个 `ResolvedCoreBatch` 和一个 history item。

不要先 `reparent` 再异步 `reposition`，也不要让 React 层根据 drop 类型自行组合两笔 command。

#### 5.4.3 验收

- root ↔ Frame、root ↔ Group、Frame ↔ Group 双向拖放；
- before/after/inside 三种落点均同时得到正确 parent 与顺序；
- 多选移动保持内部相对 z-order；
- 从 Group 移出最后一个 child 后 Group 自动消失；
- 拖入自身后代、locked container、跨 Page 和非法 parent 无副作用失败；
- Reparent 前后 moving roots 的 world corners 不变；
- Undo/Redo 和远端重放保持相同 selection result 与 canonical hash。

### WP5：快捷键、锁定继承与逐层选择

#### 5.5.1 Ungroup 快捷键优先级

调整 `editorKeyCommand` 的解析顺序：

```text
Undo/Redo、Paste
  -> Group/Ungroup shortcuts
  -> alternative Ungroup shortcut
  -> Copy/Cut/Duplicate
  -> plain Delete/Backspace
```

Alternative Ungroup 仅在“恰好选择一个 Group”时成立：

- macOS：`Meta + Delete/Backspace`；
- Windows/Linux：`Control + Backspace`，具体平台映射由 UI key adapter 统一为 command modifier；
- 普通 Delete/Backspace 仍执行 Delete；
- modifier + delete 在不满足 Ungroup 条件时不应静默删除，需要按最终产品规则选择 no-op 或平台保留行为，并用测试冻结。推荐 no-op，避免误删。

主窗口 capture listener 必须 claim 该组合键并 `preventDefault()`，避免浏览器导航或文本删除；输入框聚焦时沿用现有编辑豁免规则。

#### 5.5.2 Effective lock

新增共享层级查询：

```ts
function isEffectivelyLocked(nodesById: ReadonlyMap<string, CanvasNode>, id: string): boolean
```

它沿 parent 链向上检查 `locked`，并带 cycle guard。Rust Core 中实现等价方法，最终写事务必须由 Core 再验证，不能只依赖 UI。

应用范围：

- canvas hit/hover 与 deep select；
- pointer move/resize/rotate；
- marquee；
- keyboard move/nest/reorder；
- Group/Ungroup/Reparent/Delete/Duplicate 的可编辑性；
- Inspector 的只读状态。

Layers 面板仍可选择 locked Group 或 child 以便查看和解锁，但任何 mutation 必须拒绝；解锁入口只能修改被显式选中的锁标记，不得隐式解锁祖先。

#### 5.5.3 逐层选择

`resolveGroupSelectionTarget` 改为基于完整祖先路径：

```text
Page -> outer Group -> inner Group -> leaf
```

规则：

1. 普通点击 leaf：选择最外层可见、未锁定的 Group selection boundary；
2. 当前已选 outer Group 时双击或 Enter：选择路径中的下一层 inner Group；
3. 再次深入：选择 leaf；
4. Cmd/Ctrl deep-select 可直接选择命中的最深可编辑对象；
5. 已从 Layers 选中 child 时，在画布按下该 child 不向上提升；
6. 路径中存在 hidden/effectively locked 祖先时，不允许穿透编辑。

Marquee 规则：

- 默认只返回当前选择边界 roots；
- Cmd/Ctrl modifier 才允许选中嵌套 leaves；
- 结果中折叠 ancestor + descendant 重复项；
- locked subtree 不进入可变更选择，Layers 只读选择策略另行保留。

#### 5.5.4 验收

- alternative Ungroup 与普通 Delete 的平台矩阵完整；
- locked Group 的任何层级 child 都不能从画布编辑；
- Layers 可选中并查看 locked child，但 mutation 被 Core 拒绝；
- 三层嵌套 Group 每次只深入一级；
- Enter、双击和 deep-select modifier 结果一致；
- 默认与 modifier marquee 的边界行为符合基线。

### WP6：Group Constraints fan-out

**目标**：保持 Group 本身没有独立 Constraints，同时提供与 Figma 一致的 Group 操作入口。

#### 5.6.1 语义

当 Group 位于 Frame 的 constraint scope 内时，Inspector 显示 Constraints。读取 Group Constraints 时聚合 direct children：

- 全部相同：显示具体值；
- 值不同：显示 Mixed；
- child 不适用：按现有 mixed/not-applicable 规则呈现。

用户设置 Group Constraints 时，resolver 生成 direct children 的具体 `SetAppearance`/constraints updates；Group 记录自身仍保持 `constraints = None`。

这里采用 **direct children fan-out**，不递归写所有 descendants。嵌套 Group child 收到同一 UI intent 时，由 resolver 再按同一规则展开到它的 direct children，最终远端 operation 中只包含具体叶子或可持久节点的更新，不包含含糊的“运行时 fan-out”命令。

#### 5.6.2 事务与协作

新增 UI intent：

```ts
{ type: "set-group-constraints", id: string, axis: "horizontal" | "vertical", value: ConstraintType }
```

resolver 输出确定性的 concrete command batch：

- children 按稳定 sibling order 排序；
- 全部更新属于一个 revision、一个 history item 和一个远端 atomic batch；
- 任一 child locked、不适用或验证失败时，整笔拒绝；
- Undo 恢复每个 child 原值，包括 `undefined` 和 Mixed 状态；
- 远端重放不重新解释 Group 当前 children，避免并发结构变化导致 fan-out 集合漂移。

#### 5.6.3 验收

- Group 位于 Frame 内时可见 Constraints，Page root Group 不显示；
- 相同/Mixed/NotApplicable 状态正确；
- 单层和嵌套 Group 设置后 concrete children 值正确；
- Group 自身 Snapshot 中始终没有 constraints；
- Undo/Redo、远端重放和保存重载结果确定。

### WP7：协议、历史、协作与迁移收口

**目标**：新 Group 语义不会在本地 UI 正常、远端或旧数据上失效。

#### 5.7.1 事务输出

继续使用并扩展现有结果：

```ts
type ResolvedCoreBatch = {
  batch: CoreBatchCommand[];
  nextNodes: CanvasNode[];
  createdIds: string[];
  selectionIds: string[];
  affectedGroupIds: string[];
};
```

要求：

- `selectionIds` 是 resolver 的显式结果，Worker 不从 batch 第一条或最后一条命令猜测；
- `affectedGroupIds` 只作 UI 刷新和诊断提示，Core 自己仍根据真实变更计算需要归一化的祖先；
- 所有结构动作以具体 commands 进入 pending operation、history 和远端服务；
- 一个用户动作只对应一个 transaction ID 和 revision。

#### 5.7.2 版本与迁移

本次优先避免新增 Node 字段，因此通常无需提升 Snapshot format version。但需要：

1. 新 reader 支持旧的任意 node wire order；
2. 不改变旧 page hash 的节点排序定义；
3. 对旧文档中的 Relative-v1 Group 执行确定性规范化时，必须作为显式 migration step，并冻结 before/after fixture；
4. 如果规范化会改变 canonical hash，提升 `engine_semantics_version`，记录迁移原因和 hash 变化，不得在普通读取过程中静默改写服务端状态；
5. 服务端首次写入新 revision 时再持久化 migrated representation，且保留可审计的 migration metadata；
6. 旧客户端无法正确理解新 semantics 时必须按现有 compatibility policy 拒绝写入，而不是产生双重归一化。

#### 5.7.3 失败与诊断

为以下错误提供稳定 code，而不是统一 `Invalid`：

- `GROUP_EMPTY`
- `INVALID_PARENT_KIND`
- `HIERARCHY_CYCLE`
- `NON_INVERTIBLE_TRANSFORM`
- `DUPLICATE_SIBLING_POSITION`
- `EFFECTIVELY_LOCKED`
- `GROUP_BOUNDS_MISMATCH`

Codec 对不可信 Snapshot 可以继续映射为公开的 `SnapshotError::Invalid`，但测试和内部日志应保留具体诊断，便于定位数据损坏。

## 6. 主要文件改动清单

| 层 | 文件 | 主要改动 |
| --- | --- | --- |
| Core | `crates/editor-core/src/lib.rs` | 文档终态验证、合法容器、effective lock、Core Group normalize、空 Group 清理、错误码 |
| Codec | `crates/document-codec/src/lib.rs` | 两阶段 decode、稳定拓扑 seed、旧 Snapshot 兼容 fixture |
| WASM | `crates/editor-wasm/src/lib.rs` | 暴露新增结构/Group transform 事务或复用统一 batch 接口 |
| Protocol | `src/lib/editor-protocol.ts` | Group transform、Layer drop、constraints intent 类型；必要的错误诊断 |
| Resolver | `src/lib/transaction-batch.ts` | 统一结构事务、显式 selection、constraints fan-out |
| Geometry | `src/lib/scene-transform.ts` | preview-only normalize、统一 selection geometry、与 Core 共用 fixtures |
| Selection | `src/lib/canvas-selection.ts` | 祖先路径和逐层 drill-down |
| Keyboard | `src/lib/editor-key-command.ts` | alternative Ungroup 优先级和平台 modifier 输入 |
| Layer tree | Layers virtual list、`src/components/editor/layer-panel.tsx` | 完整 drop target 和 locked 状态呈现 |
| Worker | `src/workers/editor.worker.ts` | effective lock、intent 提交、Core projection 覆盖 preview、禁止二次 normalize |
| UI | `src/components/editor/editor-shell.tsx` | Group Inspector、drop transaction、Constraints 和 selection geometry 消费 |
| Collaboration | operation codec/rebase/reconciliation 相关文件 | concrete batch 重放、迁移和稳定错误处理 |

## 7. 测试矩阵

### 7.1 Rust 单元与属性测试

| 维度 | 用例 |
| --- | --- |
| Snapshot | UUID 逆序、节点打乱、三层嵌套、旧 fixture、缺 parent、cycle |
| Invariants | 非容器 parent、跨 Page、空 Group、重复 position、非有限/不可逆矩阵 |
| Normalize | 单/多 child、嵌套、旋转、缩放、斜切、legacy 首次迁移 |
| Structure | Group/Ungroup/Reparent/Delete/Restore/Duplicate 的原子性 |
| Lock | 自身锁、祖先锁、解锁、远端绕过 UI 写入 |
| Determinism | 同一 batch 多次重放得到相同 revision/hash/bytes |

建议为矩阵算法增加 property tests：随机生成可逆 parent/group/child 仿射矩阵，归一化前后逐点断言 child world corners 不变。

### 7.2 TypeScript 单元测试

- `editor-key-command.test.ts`：macOS/Windows alternative Ungroup 与 Delete 冲突；
- `canvas-selection.test.ts`：三层路径、逐级 drill、deep-select、Layers 保持选择；
- `scene-transform.test.ts`：preview 与 frozen Core vectors 一致；
- `transaction-batch.test.ts`：drop transaction、selection roots、source/destination normalize、constraints fan-out；
- layer tree/drop tests：before/after/inside/root 的 parent 与 insertion；
- hierarchy visibility/lock tests：effective lock 和 cycle guard；
- multi-selection tests：ancestor/descendant 折叠和 marquee 边界。

### 7.3 浏览器端到端测试

至少覆盖以下真实用户链路：

1. 创建单 child Group → 保存 → 重载 → Ungroup → 立即拖动 child；
2. 三层 Group 每次双击深入一级，再拖动 leaf；
3. Layers 把 child 从 inner Group 移到 root 的指定 sibling 之前；
4. Layers 把多选 root 拖入 Group，并保持视觉位置和内部 z-order；
5. 锁定 outer Group 后，画布不能选中或移动 leaf，Layers 可查看但不能修改；
6. Inspector 修改 Group X/Y/W/H/Rotation；
7. Group Constraints 从相同值改为 Mixed，再统一设置并 Undo；
8. 旋转 Frame 内 Group 在 25%、100%、400% zoom 下拖动/缩放，内容、选框、Handles、尺寸标签一致；
9. `⌘Delete`/`Ctrl+Backspace` Ungroup，普通 Delete 删除；
10. 两客户端或模拟远端重放相同结构 batch，最终 hash 相同。

### 7.4 当前测试基线与缺口

审查时当前定向测试结果：

- 8 个 TypeScript 文件、74 个测试通过；
- Rust Core Group 定向测试 6 个通过；
- document-codec 4 个测试通过；
- editor-wasm 按 `group` 名称过滤没有命中测试。

这些通过项不能关闭本计划，因为现有测试没有覆盖 hostile UUID 的 Snapshot 拓扑、Core Relative-v1 归一化、Group Inspector、完整 Layers drop target、祖先 lock、逐层 drill-down 和 Group Constraints fan-out。

## 8. 实施顺序与依赖

```text
WP0 冻结失败测试
  -> WP1 Snapshot + hierarchy invariants
  -> WP2 Core Group normalization
       -> WP3 Group geometry / Inspector
       -> WP4 Layers structural drop
       -> WP5 lock / selection / shortcuts
       -> WP6 Constraints fan-out
  -> WP7 collaboration / migration / diagnostics
  -> full regression + browser acceptance
```

建议按以下可合并切片实施：

1. **切片 A（P0 数据安全）**：G-01、Snapshot 两阶段恢复、非法 parent 和 cycle 测试；
2. **切片 B（Canonical 语义）**：Core normalize、非空 Group、effective lock 的 Core 兜底；
3. **切片 C（结构入口）**：统一 Layer drop、Group/Ungroup/Reparent 与 selection output；
4. **切片 D（几何入口）**：Group Inspector、画布控件和统一 selection geometry；
5. **切片 E（交互兼容）**：快捷键、逐层选择、marquee、Layers locked UX；
6. **切片 F（Constraints 与协作）**：fan-out、concrete remote batch、迁移与诊断；
7. **切片 G（Gate）**：全量测试、真实浏览器证据、性能与稳定性回归。

WP3–WP6 可在 WP2 的 Core API 和 fixtures 冻结后并行开发，但合并时必须逐个重跑完整 Group gate。WP7 不应最后才开始设计；协议与 migration 评审应在 WP1/WP2 API 冻结时同步完成。

## 9. 验收 Gate

只有以下条件全部满足，Group 整改才能标记完成：

### 数据与结构

- 任意合法嵌套 Group 可保存、重载，输入 node 顺序不影响结果；
- 空 Group、非法 parent、cycle、跨 Page 和重复 position 不能持久化；
- 旧 Snapshot fixture 可读取，page hash 兼容策略有自动测试；
- 一个手势只形成一个 revision、history item 和远端 atomic batch。

### 几何

- Group Bounds 在所有写入入口后贴合 direct children；
- Group/Ungroup/Reparent/normalize 前后，未要求移动的 child world corners 逐点不变；
- Inspector、Pointer、Keyboard 得到同一几何结果；
- 旋转、缩放、斜切、嵌套和不同 zoom 下无选框或尺寸标签漂移。

### 交互

- Layers 的 before/after/inside/root drop 都能正确移入、移出和排序；
- locked Group 的后代不可从任何编辑入口修改；
- 嵌套 Group 的双击/Enter 每次深入一级，deep-select 与 marquee modifier 行为确定；
- alternative Ungroup 和普通 Delete 不冲突；
- Group Constraints 正确 fan-out，Group 自身不存独立 constraints。

### 确定性与质量

- Undo/Redo、保存重载、本地重放和远端重放得到相同 canonical hash；
- TS preview 与 Core 结果在约定 epsilon 内一致；
- 全量 TS、Rust、WASM、codec、service 和 Playwright 测试通过；
- 无 console error、panic、非有限矩阵、孤儿节点或空 Group；
- 现有 Frame、Section、普通节点移动/resize/constraints 无回归。

## 10. 风险、回滚与观测

| 风险 | 控制措施 |
| --- | --- |
| Core normalize 改变大量几何路径 | 先冻结矩阵 fixtures；以 world corners 和 hash 做双重断言 |
| 修复 wire order 破坏旧 page hash | codec 内拓扑 seed，不直接改变 `ordered_nodes_on_page` 的 hash 口径 |
| TS preview 与 Core 双重归一化 | 明确 preview-only；Core projection 到达后整体替换，不再 normalize |
| 结构 batch 中间出现空 Group | working copy 上执行，终态统一 validate 后才提交 |
| Constraints fan-out 与并发 Reparent 竞争 | 远端存 concrete child updates；按 base revision 正常 rebase/拒绝 |
| effective lock 只在 UI 生效 | Worker 与 Core 双层验证，远端 replay 同样检查 |
| 旧文档规范化导致 hash 改变 | 显式 engine semantics migration，冻结 before/after fixture 和审计记录 |

上线前建议增加临时诊断计数：

- Group normalize 次数、层级深度和失败原因；
- preview/Core 几何偏差；
- Snapshot topo reorder 次数；
- empty Group 自动清理次数；
- invalid parent/effective lock 拒绝次数；
- remote Group batch replay/rebase/reject 数量。

若出现高频几何偏差或旧 Snapshot 恢复失败，应停止写入新 semantics，保留 reader 兼容修复，回滚 UI intent 入口；不得回滚为“只写 `x/y`”或跳过 Core validation。

## 11. 非目标

本计划不把 Group 升级为 Frame，也不包含：

- Auto Layout、Clip Content、独立 Fill/Stroke/Effect；
- Component/Instance/Variant；
- Figma 私有 `.fig` 文件读写；
- 任意形状的视觉描边 Bounds；Group 继续按节点几何 Bounds 定义内容贴合；
- 与 Group 修复无关的通用渲染器或协议重构。

如实施过程中发现必须新增协议字段或改变 Snapshot format，需单独提交 ADR，说明兼容窗口、迁移 fixture、旧客户端写入策略和回滚方案，不得在本计划下隐式扩大范围。
