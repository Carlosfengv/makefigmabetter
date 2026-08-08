# Group 图层四项优先问题修复文档

> 状态：待实现评审
> 优先级：P0
> 整理日期：2026-08-08
> 范围：Group、Ungroup、Group/子图层拖拽、选框与尺寸标签
> 本文只定义行为、数据模型、根因与实施/验收方案，不在本阶段修改产品代码。

## 1. 结论

四个问题来自同一组基础不一致，不应分别打补丁：

1. 产品入口和事务解析器把 Group 错误限制为“至少两个选中图层”，而 Figma API 的真实约束是“节点列表非空”。因此单个图层应能被包装为一个拥有一个 child 的 Group。
2. 项目处于 `x/y/rotation` 与 `relativeTransform` 双读阶段。Group/Ungroup 后，`relativeTransform` 是权威坐标，但旧移动路径只写 `x/y`，导致持久化后的视觉位置不变或选框与图层分离。
3. Group 的 Bounds 应由 children 派生。当前部分代码用世界空间 Bounds 回写 Group 的 `x/y/width/height`，部分代码又因为 child 含 `relativeTransform` 而跳过刷新；两条策略互相矛盾，无法同时保证 Group 收边、child 世界位置不跳动和选框正确。
4. Ungroup 后的 children 仍保留相对矩阵是合理的，但移动提交必须更新相对矩阵；同时 Ungroup 的选择结果不能靠猜测 batch 第一条命令得到。

修复时必须建立一个共同规则：**节点世界矩阵是渲染、命中、拖拽、选框和尺寸标签的唯一几何来源；Group 的局部 Bounds 由 children 归一化派生。**

## 2. Figma 官方行为基线

### 2.1 创建 Group

Figma Plugin API 使用：

```ts
figma.group(nodes, parent, index?)
```

官方约束和行为：

- `nodes` 必须非空，不要求至少两个节点；因此一个节点可以成为一个 Group 的唯一 child。
- 不提供 `createGroup()`，因为 Figma 不允许空 Group。
- 创建时必须明确 parent，目的是在 reparent 的同时保持被分组节点的绝对位置。
- 可选 `index` 决定 Group 在 parent children 中的位置；children 顺序为从后到前，最后一个 child 是视觉最上层。
- Group 的位置和尺寸始终贴合内容；child 变化时 Group 也必须重新贴合。
- 移走或删除最后一个 child 后，空 Group 自动删除。

参考：

- [Figma `group` API](https://developers.figma.com/docs/plugins/api/properties/figma-group/)
- [Figma GroupNode](https://developers.figma.com/docs/plugins/api/GroupNode/)
- [Figma children 顺序](https://developers.figma.com/docs/plugins/api/properties/nodes-children/)

### 2.2 坐标与数据格式

Figma 的关键字段语义：

- `type: "GROUP"`。
- `children: SceneNode[]`，Group 必须始终有 children。
- `relativeTransform` 是节点相对于 parent 的 2×3 仿射矩阵。
- `x === relativeTransform[0][2]`，`y === relativeTransform[1][2]`；它们不是另一套独立坐标真相。
- `absoluteTransform` 是节点相对于 Page 的矩阵。
- `absoluteBoundingBox` 是 Page/世界坐标中的轴对齐包围盒，不含阴影和描边等渲染外扩。
- `width`、`height` 是节点自身尺寸；插件侧为只读，通过 resize 方法改变。Group 的尺寸会随内容变化。

REST API 中 `GROUP` 复用 Frame 的数据属性集合，但这不代表 Group 具有 Frame 的独立布局盒、裁剪和 Auto Layout 语义。

参考：

- [Figma GroupNode 布局字段](https://developers.figma.com/docs/plugins/api/GroupNode/)
- [Figma `x` 字段](https://developers.figma.com/docs/plugins/api/properties/nodes-x/)
- [Figma REST Node types](https://developers.figma.com/docs/rest-api/file-node-types/)

### 2.3 Ungroup

`figma.ungroup(node)` 的行为：

- 把 Group 的全部 children 移到 Group 的 parent；
- 删除原 Group；
- 返回原 children；
- 如果原 Group 在当前选择中，Ungroup 后选择原 children；
- children 的画布视觉位置不能变化。

参考：[Figma `ungroup` API](https://developers.figma.com/docs/plugins/api/properties/figma-ungroup/)

### 2.4 选择和移动

Figma 编辑器的交互基线：

- 普通点击 Group 内对象，默认先选择 Group。
- 双击、深入选择或从 Layers 面板点击，可以选中 Group 内的单个 child。
- 选中 Group 后拖动，整个 Group 子树一起移动。
- 选中 child 后拖动，只移动该 child；Group Bounds 随 children 自动缩放/偏移。
- 选中 parent 等价于拥有其 children，移动时不得让 child 重复叠加位移。

参考：

- [Figma Groups 与 Frames 的区别](https://help.figma.com/hc/en-us/articles/360039832054-The-difference-between-frames-and-groups)
- [Figma 选择嵌套图层](https://help.figma.com/hc/en-us/articles/360040449873-Select-layers-and-objects)

## 3. 项目 Canonical 数据规则

### 3.1 Group 记录

项目现有扁平记录可以继续使用，但必须明确权威关系：

```ts
type GroupRecord = {
  id: string
  kind: "group"
  pageId: string
  parentId?: string
  positionId: string
  relativeTransform?: { a: number; b: number; c: number; d: number; e: number; f: number }
  x: number
  y: number
  width: number
  height: number
  rotation: number
}
```

规则：

- 新建、Group、Ungroup、Reparent 后的节点优先写 `relativeTransform`。
- `relativeTransform` 存在时，它是权威坐标；`x/y/rotation` 只可作为兼容投影，不能由编辑路径单独更新。
- `relativeTransform` 不存在的旧节点继续读取 legacy `x/y/rotation`，第一次结构或矩阵编辑时迁移。
- Group 不拥有 Fill、Stroke、Clip 或独立 Constraints 语义。
- Group `width/height` 和位置由 children 的局部几何派生，不是自由编辑的固定 Frame Bounds。
- 空 Group 是非法持久状态。

### 3.2 世界矩阵

统一使用：

```text
world(node) = world(parent) × local(node)
```

Reparent 保持视觉位置：

```text
newLocal(node) = inverse(world(newParent)) × oldWorld(node)
```

世界空间拖动 `(dx, dy)`：

```text
newWorld(node) = translate(dx, dy) × oldWorld(node)
newLocal(node) = inverse(world(parent)) × newWorld(node)
```

矩阵不存在、含非有限数值或 parent 不可逆时，整笔事务拒绝，不能只提交 `x/y` 降级结果。

### 3.3 Group Bounds 归一化

这是四项修复的核心。不能把 children 的世界 AABB 直接写入一个仍带 parent-relative transform 的 Group。

对 Group 的所有 direct children：

1. 在 Group 局部坐标中计算每个 child 四个角点。
2. 求联合局部 AABB `B = [left, top, right, bottom]`。
3. Group 新尺寸为 `right - left`、`bottom - top`。
4. Group local transform 追加 `translate(left, top)`。
5. 每个 direct child 的 local transform 前置 `translate(-left, -top)`。
6. 因此每个 child 的 world transform 完全不变，而 Group 原点和 Bounds 正好贴合内容。
7. 内层 Group 先归一化，再向外层 Group 递归；顺序必须确定。

等式：

```text
newGroupLocal = oldGroupLocal × T(left, top)
newChildLocal = T(-left, -top) × oldChildLocal

world(parent) × newGroupLocal × newChildLocal
= world(parent) × oldGroupLocal × oldChildLocal
```

该算法同时覆盖：

- child 在 Group 内移动后 Group 自动收边；
- 旋转 child；
- 旋转/缩放/斜切 parent；
- 嵌套 Group；
- 单 child Group。

Dual-read 期间若 Group direct child 仍是 legacy 世界坐标，进入 Group 归一化前先把该 child 物化为 parent-relative transform，禁止在一次计算中混用局部矩阵和世界 `x/y`。

## 4. 四个问题的根因与修复要求

### P0-1 单个图层无法成为 Group

#### 当前根因

当前工作区中存在三处显式的“至少两个”限制：

- `src/lib/editor-key-command.ts`：快捷键只在 `selectedIds.length >= 2` 时产生 Group command。
- `src/components/editor/layer-panel.tsx`：Group 按钮在少于两个选中项时禁用。
- `src/lib/transaction-batch.ts`：要求 `selected.length >= 2` 且折叠祖先选择后的 `roots.length >= 2`。

这与 Figma `group(nodes, parent, index?)` 的“non-empty”约束不一致。

#### 修复要求

- 三层校验统一改为“至少一个合法 selection root”。
- 选择同时包含 ancestor 与 descendant 时，先折叠为一个 root，再允许为该 root 外包一层新 Group。
- 单图层 Group 的 Bounds 与该 child 的视觉 Bounds 一致。
- child world transform 在 Group 前后逐点不变。
- 新 Group 成为唯一选择。
- 空选择、缺失节点、不可 reparent 节点、跨 Page、成环或不可逆 parent 仍整笔拒绝。

#### 必测用例

- Page 根下单 Rectangle → Group。
- 旋转 Frame 内单图层 → Group。
- 单个已有 Group → 再包一层嵌套 Group。
- ancestor + descendant 同选 → 只创建一层 wrapper，节点不重复 reparent。
- Undo/Redo 恢复相同 ID、parent、position、transform 和 canonical hash。

### P0-2 Group 移动时高亮框和底部尺寸标签位置异常

#### 当前根因

- Dual-read 下，Group 可能已有 `relativeTransform`；旧拖动只改 `x/y`，渲染投影仍读取原 `relativeTransform`。
- 选框、尺寸标签、拖动临时态和 Core Bounds 刷新未共享同一个几何结果。
- Core 的 `refresh_group_bounds` 以 child 世界 Bounds 回写 Group `x/y/width/height`；当 Group 自身 `relativeTransform` 仍为权威时，`x/y` 回写不控制其世界位置。
- Worker 的 `refreshTransientGroupBounds` 遇到 Relative-v1 child 会直接跳过，虽然避免了二次位移，却让 child 移动后的 Group Bounds 过期。

当前未提交工作中已有 `translateNodeWorldPatch`，能区分 legacy 与 Relative-v1 移动，这是正确方向；但它不能替代 Group 局部 Bounds 归一化。

#### 修复要求

- 拖动 Group 时：更新 Group 的权威 local transform；children local transform 不变；禁止对子树重复加位移。
- 拖动过程中和提交后都使用同一套 world transform 解析。
- 选框四角来自 Group local rectangle 经 world transform 后的点。
- 尺寸文字来自 Canonical Group `width × height`。
- 标签锚点来自同一选框几何，水平居中放在选框屏幕底边下方固定 UI 偏移；不得再次读取未投影的 `x/y`。
- 单选选框、Hover、Resize Handles、Hit Test、尺寸标签必须消费同一 `ResolvedSelectionGeometry` 或等价单一结果。
- 子图层移动引发的 Group 收边必须用第 3.3 节归一化，不得通过“跳过刷新”长期保留旧 Bounds。

#### 必测用例

- Page 根 Group 拖动。
- Frame 内 Relative-v1 Group 拖动。
- 旋转 Frame 内 Group 拖动。
- 旋转 Group、嵌套 Group、缩放视口下拖动。
- 拖动每一帧断言：内容 Bounds、蓝色选框、8 个 Handle、尺寸标签的屏幕位置一致。
- Pointer Up、Undo、Redo、保存重载后位置不跳变。

### P0-3 Ungroup 后图层无法移动

#### 当前根因

- Ungroup 为保持视觉位置，会给 former children 写新的 `relativeTransform`。
- 旧 `move_nodes` 仅写 `x/y/width/height`；世界投影忽略这些兼容字段的位移，所以画布看起来被冻结，或松手后回弹。
- Worker 当前通过检查 `resolved.batch[0]` 是否为 `reparent` 来推断 Ungroup 后选择；但实际 batch 先包含 child update，再包含 reparent，因此会错误清空选择。
- child 原 `positionId` 只在旧 Group 兄弟域内唯一，直接复用到 Group parent 的兄弟域可能冲突或破坏顺序。

#### 修复要求

- Ungroup 为每个 child 计算相对于 Group parent 的 `newLocal = inverse(parentWorld) × oldChildWorld`。
- former children 的世界位置、旋转和尺寸必须不变。
- 在 Group 原 position 附近为 children 生成新的 sibling `positionId`，保持原 children 从后到前顺序且不与现有兄弟冲突。
- 删除 Group 与 reparent children 必须是一个原子事务和一个 HistoryItem。
- `resolveCoreBatch` 应显式返回 `selectionIds`/`affectedIds`；Worker 不得从 batch 命令顺序推断选择。
- Ungroup 后直接选中 former children。
- 后续移动统一提交 transform-aware update；不得再调用只支持 legacy `x/y` 的提交接口。

#### 必测用例

- 单 child Group → Ungroup → 立即拖动。
- 多 child Group → Ungroup → children 保持顺序并作为多选整体移动。
- Frame/旋转 Frame/嵌套 Group 内 Ungroup 后移动。
- parent 已有冲突 PositionId 的 hostile fixture。
- Undo 恢复原 Group ID 和原 child 局部矩阵；Redo hash 一致。

### P0-4 选中 Group 内子图层无法移动

#### 当前根因

主要根因与 P0-3 相同：被分组 child 的世界坐标由 `relativeTransform` 决定，而 legacy move 只更新 `x/y`。

此外，完整行为还依赖：

- 普通点击先选 Group，深入选择后才选 child；
- child 已被选中后，pointer down 不应重新折叠回 Group；
- 只移动 selection roots，ancestor 与 descendant 同选时不能对子图层叠加第二次位移；
- child 移动后必须同步归一化当前 Group 及外层 Group Bounds。

#### 修复要求

- 保留现有“Group 是默认选择边界、drill-down 选择 child”的方向。
- child 拖动用世界 delta 计算新的 parent-relative transform。
- 一次拖动的每一帧都基于 pointer-down 的不可变快照，防止 delta 累加。
- child transform、Group Bounds 归一化、所有受影响 sibling rebase 和嵌套 Group 更新在同一事务提交。
- Group 自身不应在 child 拖动时额外带动 child；归一化前后只有被拖 child 的 world transform 改变。
- locked/hidden child、不可逆祖先矩阵和跨 Page 情况明确拒绝。

#### 必测用例

- 双击选择 Group 内 Rectangle 后拖动。
- 从 Layers 面板选择 child 后拖动。
- 单 child Group 内移动：Group 跟随 child，child 不发生二次位移。
- 多 child Group 内移动左上 child：Group 原点改变，所有未移动 sibling 世界位置保持不变。
- 移动右下 child：Group 仅扩展尺寸，未移动 sibling 不变。
- 嵌套 Group 内 child 移动：内外 Group 依次收边。
- 旋转、缩放、斜切 parent 下保持准确 world delta。

## 5. 建议实施顺序

1. **先补失败测试**：覆盖单图层 Group、Group 拖动 overlay、Ungroup 后拖动、Group child 拖动四条端到端链路。
2. **统一 transform authority**：把现有 `translateNodeWorldPatch` 收口为拖动唯一入口，删除/停用仅写 legacy `x/y` 的 Group 相关 move 路径。
3. **实现 Core Group 局部归一化**：替换世界 Bounds 回写与 Relative-v1 跳过刷新策略；支持嵌套递归和 undo/redo。
4. **修复 Group resolver**：允许一个 root；创建时保持 world transform；确定 Group sibling position。
5. **修复 Ungroup resolver**：生成新 sibling positions，显式返回 selection IDs，保持 world transform。
6. **统一 overlay geometry**：Selection、Hover、Handles、Hit Test 和尺寸标签共用 world-derived geometry。
7. **浏览器验证与持久化验证**：不同 zoom、旋转 parent、保存重载、Undo/Redo、服务重放全部通过后再关闭 P0。

建议主要改动位置：

- `src/lib/editor-key-command.ts`
- `src/components/editor/layer-panel.tsx`
- `src/lib/transaction-batch.ts`
- `src/lib/scene-transform.ts`
- `src/lib/canvas-selection.ts`
- `src/workers/editor.worker.ts`
- `crates/editor-core/src/lib.rs`
- 相关 TS、Rust 与 Playwright 回归测试

## 6. 统一事务输出建议

避免 Worker 再从底层 batch 顺序猜测 UI 状态：

```ts
type ResolvedCoreBatch = {
  batch: CoreBatchCommand[]
  nextNodes: CanvasNode[]
  createdIds: string[]
  selectionIds: string[]
  affectedGroupIds: string[]
}
```

- Group：`selectionIds = [newGroupId]`。
- Ungroup：`selectionIds = formerChildIds`。
- Move child：`selectionIds` 保持不变，`affectedGroupIds` 包含由内到外的 Group。
- Move Group：`selectionIds` 保持不变，只更新 selection roots。

UI selection 不进入 Canonical document hash，但必须由同一 resolver 的确定性结果驱动。

## 7. 验收门槛

四项问题只有在以下条件全部满足后才能标记完成：

- 单个合法图层能通过按钮和 `⌘/Ctrl+G` 创建 Group。
- Group 创建前后 child 世界四角逐点一致。
- Group 拖动时图层、选框、Handles 和尺寸标签全程一致，无偏移、跳动或松手回弹。
- Ungroup 前后 children 世界四角逐点一致，且 children 自动成为选择。
- Ungroup 后 children 可立即拖动并正确持久化。
- 深入选择 Group child 后可移动，Group Bounds 实时贴合，其他 sibling 不移动。
- 嵌套 Group、旋转 parent、不同 zoom 下行为一致。
- Pointer Up、Undo、Redo、保存重载和服务重放无跳变，canonical hash 确定。
- 一个手势只产生一个 revision、一个 HistoryItem 和一个远端原子 operation batch。
- 所有矩阵有限、可逆；PositionId 在新兄弟域唯一；空 Group 不可持久化。

## 8. 当前测试证据与缺口

整理本文时执行的当前工作区测试：

- TS 定向测试：5 个文件、61 个测试通过。
- Rust Group 定向测试：6 个测试通过。

这些测试说明当前未提交工作已经覆盖部分 transform helper 和 Core 回归，但仍不能证明四个用户问题完成，原因是：

- 单图层 Group 仍被产品入口和 resolver 明确拒绝。
- 没有验证 Group 拖动期间的真实选框与尺寸标签屏幕位置。
- 当前 Relative-v1 child 的临时 Group Bounds 刷新采用跳过策略，不满足 Figma 的内容贴合规则。
- Ungroup 选择结果仍依赖错误的 batch-first-command 推断。
- 缺少四条真实 pointer 流程的浏览器级回归和保存重载证据。

因此当前状态应标记为：**已定位、部分底层修补存在、尚未达到 P0 验收。**
