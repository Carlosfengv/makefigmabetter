# Phase 2 图层类型实现复核

- 状态：历史缺口复核已完成；当前实现状态以 `phase2-remaining-implementation-plan.md` 为准，所有类型仍待最终 Gate
- 复核日期：2026-08-08
- 复核范围：Phase 2 节点类型、已实现类型的不变量，以及达到 `Supported` 所需的完整链路
- 依据：架构总纲 §7.2、Phase 2.1–2.16、Common Nodes 实施方案 §4.2/§5、ADR 0023 与当前工作区实现

## 1. 结论

Phase 2 的原始节点类型目标不是只有 Section、Group、Line 和 Vector，而是以下 8 类：

`Section、Group、Line、Polygon、Star、Vector、BooleanOperation、Slice`

本复核最初发现的 5 类缺失节点现已进入 Canonical Schema、快照、操作、服务、WASM 和编辑器候选链路；但这并不构成 `Supported` 声明。因此：

- 以“NodeKind 已进入候选跨层链路”计算，覆盖为 **8/8**；
- Polygon、Star、Vector、BooleanOperation 和 Slice 仍是候选/Partial，尚未获得独立验收；
- Group 和 Line 的最终跨层矩阵同样未冻结，不能仅凭枚举、渲染或已有测试直接标记为严格 `Supported`；
- Common Nodes 候选只能代表 Phase 2A 子里程碑，不能代表完整的 Phase 2 图层类型目标完成。

原始缺口结论保留在下文作为审计轨迹；当前工作包、证据与阻塞项由《Phase 2 剩余能力落地计划》维护。

## 2. 原始目标与当前状态矩阵

`Supported` 必须同时覆盖 Canonical Schema、Operation、Snapshot、Worker、Renderer、Hit Test、Layers/Inspector、Copy/Duplicate/Delete/Undo/Redo、服务重放 Hash、导出/报告、自动 Fixture 与人工验收。

| Phase 2 类型 | Schema / Core | Worker / Render / Hit | Layers / Inspector | Snapshot / Operation / Service | Export | Fixture / Acceptance | 复核结论 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Section | 已有 | 已有 | 已有 | 已有 | SVG 已有 | Common Nodes 有覆盖 | 候选，待 R2 独立验收冻结 |
| Group | 已有 | 已有；Relative-v1 Bounds 已有候选修复 | 已有 | 已有 | 结构参与导出 | 有覆盖，但最终矩阵未冻结 | Partial |
| Line | 已有 | 已有 | 已有 | 已有 | SVG 已有 | 最短线段固定端点候选已覆盖；Group 命中决策见 ADR 0033 | Partial |
| Polygon | 候选已接入 | Rust/WASM Canvas、Hit、Bounds 候选 | 创建、Layers、Inspector 候选 | 已接入 | SVG/PNG/PDF 候选 | 专业 Fixture 与浏览器矩阵候选 | Partial，待独立验收 |
| Star | 候选已接入 | Rust/WASM Canvas、Hit、Bounds 候选 | 创建、Layers、Inspector 候选 | 已接入 | SVG/PNG/PDF 候选 | 专业 Fixture 与浏览器矩阵候选 | Partial，待独立验收 |
| Vector | 候选已接入 | Rust 几何、Canvas/Hit 候选 | Inspector、锚点/控制柄候选 | 已接入 | SVG 候选 | Fixture 与 Pen/点编辑回归候选 | Partial |
| BooleanOperation | 候选已接入 | Rust clipping、Canvas/Hit/Flatten 候选 | 活结构与 Flatten UI 候选 | 已接入 | SVG 候选；PDF 仍有缺口 | Fixture 与浏览器事务候选 | Partial |
| Slice | 候选已接入 | 非绘制型选择/编辑候选 | Layers、Inspector 候选 | 已接入 | SVG/PNG/PDF 区域导出候选 | 专业 Fixture 候选 | Partial |

说明：矩阵中的“已有”表示链路存在，不等同于独立 Gate 已签署。

## 3. Review Findings

### 已缓解：五类 Phase 2 节点曾完全缺失，计划与架构范围发生漂移

架构总纲 §7.2 明确列出 8 类 Phase 2 节点；本条为 2026-08-08 的初始审计发现。当时 Protobuf、Rust 和 TypeScript 的 NodeKind 只有 Frame、Rectangle、Ellipse、Text、Image、Line、Group、Section。Polygon、Star、Vector、BooleanOperation 和 Slice 现已进入候选链路，故不再是当前 P0；其完整 Gate 仍未关闭。

影响：

- Polygon/Star 无法创建、保存、复制、编辑或导出；
- VectorPath/Pen 没有稳定的节点载体；
- Boolean 只能被设想为一次性命令，无法满足总架构中的 `BooleanOperation` 节点目标；
- Slice 无法作为非绘制型导出区域参与图层树和导出；
- 当前固定 Fixture、兼容矩阵和最终 Gate 都无法证明完整图层类型范围。

处理结果：Polygon/Star、BooleanOperation Node 和 Slice 已恢复为独立工作包；在它们通过完整跨层和独立验收前，Phase 2 图层类型 Gate 保持未通过。

### P1：Relative-v1 Group 的派生 Bounds 已接入 Canonical 提交路径，等待完整矩阵冻结

Group 规范要求 Bounds 始终由 children 派生。Core 的 `refresh_group_bounds` 对带 `relative_transform` 的 Group 直接跳过，因此客户端必须在进入 Core 的同一事务内补足归一化命令。现已由 `resolveCoreBatch` 消费 `affectedGroupIds`：它收集受更新、重组和嵌套变换影响的 Group 及祖先，追加父级先于子级的确定性 `update` 投影，并保持 child 的世界变换。

这消除了此前 Inspector/单节点 Resize 后 Group 存储的 x/y/width/height 可能陈旧的直接路径。候选实现已由 TypeScript 原子 batch 测试和完整 Rust workspace 测试覆盖；仍未获得跨层最终冻结矩阵签署。

剩余验收：嵌套 Relative Group、旋转/斜切/镜像父级、Inspector 数值编辑、单选 Resize、Reparent、Undo/Redo、WASM 与服务重放的最终冻结矩阵。

### P1：Core 事务后 Group 非空不变量已实现，等待跨层验收

产品映射规定 Group 只能从非空选择创建，最后一个 child 离开后自动解散。Core 现在在事务中全部命令应用完成、revision/history 写入之前检查每个 Group 是否含有 direct child。单独的 `Create(Group)` 以 `EmptyGroup` 拒绝，且不改变文档状态；Group 与 child 同事务创建仍可提交。

这将约束放在 Canonical 提交边界而非单条 Create 前置条件，保留 Group + children 的原子创建、末 child 移出时的自动解散和 Undo/Redo 原子性。Core 单测、WASM 固定快照迁移及 workspace 测试已经通过；服务重放和真实浏览器的完整矩阵仍待冻结。

### P1：未知节点降级策略与总架构契约冲突

架构总纲 §7.2 要求未实现的已知 Figma Node 以 UnknownNode/Extension Payload 占位，并允许移动、复制和删除；ADR 0023 后来选择了“整个 Snapshot 拒绝并进入只读”。两种策略都不会静默改写数据，但产品行为完全不同。

随着 Polygon、Star、Vector、BooleanOperation、Slice 逐步上线，旧客户端遇到任一新类型都会使整个混合文档不可编辑，而不是只降级对应节点。这不是隐藏实现问题，而是尚未回写总架构的决策分叉。

处理：在新增 NodeKind 前完成一次 ADR 复议，二选一：

1. 实现 UnknownNode 占位闭环，恢复总架构原契约；或
2. 正式修改总架构 §7.2 与兼容矩阵，接受“文档级只读”并把版本互操作限制写入 Phase 2 Gate。

### P2：Line 最小长度固定端点候选已实现，等待跨层冻结

Line 端点 Resize 在请求长度小于 4px 时，现以未拖拽的对侧端点为圆心，把拖拽端投影到半径 4px 的请求方向上。请求与固定端点重合时采用拖拽前正向基。Legacy 与 Relative-v1 两条路径均采用该规则，因此最小长度钳制不会移动固定端点。

单测已断言两条路径的端点、跨越对侧、零距离、旋转/镜像父级下的固定世界端点。真实画布两端拖拽、Undo/Redo 与服务重放仍需在最终冻结源码上验收，故 Line 保持 `Partial`。

### 已关闭 P2：Group 空白区域命中语义

ADR 0033 已冻结：Group 的派生 Bounds 空白区域直接选择 Group；命中可见 child 时先保持最外层 Group 编辑边界；重复点击逐层进入嵌套 Group，最终到达 child。`hit-test` 与 `canvas-selection` 单测分别覆盖 Bounds/child 优先级和嵌套 drill-down，因此 Canvas 与 Layers 对 Group 的选择不再存在未决分叉。像素 Golden 与独立浏览器验收仍待最终 Gate。

### P2：固定 Fixture 和兼容矩阵没有覆盖完整 Phase 2 类型

复核前，`phase2-common-nodes.fixture.json` 只包含 Frame、Group、Rectangle、Ellipse、Line、Section 和 Text；兼容矩阵也只有 Group/Line/Arrow/Section 合并行，没有 Polygon、Star、Vector、BooleanOperation、Slice 的独立状态。本次已先拆分兼容矩阵并把五类缺失节点显式标为 `Later`，但固定 Fixture 与跨层验收仍为空。

处理：保持 8 类 Phase 2 新增节点的独立追踪行；为五类新增节点建立固定 Fixture 和跨层验收矩阵。`Later` 必须显式写出，不能因没有行而被误解为不在范围。

## 4. 必须先冻结的四个语义决策

### D1：Polygon 与 Star 是参数节点还是创建后立即转 Vector

建议保留独立 NodeKind 和最小参数：Polygon 的 `point_count`；Star 的 `point_count` 与 `inner_ratio`。Resize、圆角和转换为 Vector 的行为需由 ADR 冻结。若决定创建后立即转 Vector，必须同步修改架构 §7.2，不能保留名义节点目标。

### D2：BooleanOperation 是活结构还是一次性 Flatten

总架构当前要求 `BooleanOperation` NodeKind。建议采用保留 children 的活结构，节点记录 `union/intersect/subtract/exclude`，渲染与命中消费确定性的派生 Path；Flatten 才生成普通 Vector。若只交付一次性命令，则应明确删去 BooleanOperation 节点目标并说明兼容代价。

### D3：Slice 的产品语义

建议定义为非绘制型矩形导出区域：存在于 Layers，可选择、移动、Resize、重命名、复制、删除和 Undo/Redo；不参与普通 Paint/Hit 的视觉内容，但它的边界用于导出。需冻结是否允许 children、是否裁剪导出、嵌套容器后的坐标行为以及 SVG/PDF/PNG 的导出入口。

### D4：UnknownNode 还是文档级只读

该决策必须先于新增枚举值和兼容测试，否则每交付一种新节点都会改变旧客户端对混合文档的可用性。

## 5. 修正后的落地工作包

```text
T0 图层类型 ADR 与兼容策略冻结
  ↓
T1 NodeKind / Snapshot / Operation append-only 扩展
  ├─ T2 Polygon + Star 参数图形闭环
  ├─ T3 VectorPath Canonical 与几何内核
  └─ T5 Slice 导出区域闭环
       T3 → T4 BooleanOperation 活结构与 Flatten
  ↓
T6 全类型 Fixture、兼容矩阵与独立验收
```

### T0：语义与兼容冻结

- 完成 D1–D4 ADR；
- 写出每类节点的属性、容器能力、Paint 能力、导出能力和降级规则；
- 冻结资源预算：point count、subpath、Boolean children、递归深度和序列化字节；
- 规定旧客户端遇到新 NodeKind 的行为。

### T1：跨层骨架

- Protobuf 只追加 5 个 NodeKind，不重用字段号；
- Rust/TypeScript/WASM 枚举和 exhaustive match 同步；
- Snapshot 迁移、Operation adapter、Service replay 与 Canonical Hash Fixture；
- 在完整能力未接通前不得把新类型标为 Supported，也不得回退成 Rectangle。

### T2：Polygon 与 Star

- Canonical 参数、创建工具、Inspector、Bounds、Fill/Stroke、精确 Hit Test；
- Canvas/WebGPU 正式路径或明确 fallback；
- Resize、旋转、镜像、Copy/Duplicate、Undo/Redo、SVG/PNG/PDF；
- “Convert to Vector” 作为单事务结构转换并保留可撤销性。

### T3：Vector

- 复用现有计划 G1/G2：多 Subpath、锚点、控制柄、Fill Rule、Pen 与点编辑；
- 几何、Hit Test、Mask、Boolean 和导出共用 Rust 单一事实来源。

### T4：BooleanOperation

- 新增独立节点及 operation enum；
- children 顺序、Subtract 主体、空结果、开放路径与退化输入语义确定；
- 派生 Path 不写 Snapshot，输入 children 和 operation 才是 Canonical；
- Flatten 生成 Vector，Undo 可完整恢复原 BooleanOperation 子树。

### T5：Slice

- 非绘制型节点投影、选择框、图层树、Inspector 几何和 Export 面板；
- 明确 Slice 自身不输出 Paint，只定义导出区域；
- PNG/SVG/PDF 使用冻结 revision 和同一世界矩阵；
- 越界、旋转、嵌套、隐藏/锁定和多 Slice 批量导出有确定行为。

### T6：验收闭环

- 兼容矩阵逐类型独立成行；
- 固定 Fixture 同时包含 8 类 Phase 2 新节点及嵌套/旋转/镜像组合；
- 每类覆盖创建、编辑、保存恢复、复制、删除、Undo/Redo、服务重放、Hash 和导出；
- 未参与实现的人完成 Golden、可访问性和固定操作脚本验收。

## 6. 各类型完成定义

| 类型 | 最小可验收场景 |
| --- | --- |
| Section | 创建、嵌套、标题、隐藏内容、Resize 不传播普通 Constraints、保存与导出一致 |
| Group | 只从非空选择创建、Bounds 始终由 children 派生、最后 child 离开自动解散、嵌套 Relative-v1 不漂移 |
| Line | 两端点编辑、最短长度、独立 Cap、Dash、旋转/镜像父级、固定端点世界坐标不动 |
| Polygon | 3–100 边参数、Resize/旋转、Fill/Stroke/Hit、转 Vector、保存与导出一致 |
| Star | 点数与 inner ratio 边界、凹形 Fill Rule、Hit、转 Vector、保存与导出一致 |
| Vector | 开闭路径、多 Subpath、控制柄、自交、Fill Rule、Pen 编辑、退化路径和资源预算 |
| BooleanOperation | 四种 operation、children 重排、相切/包含/空结果、自交、Flatten、Undo 与服务重放 |
| Slice | 创建/移动/Resize/重命名、多区域导出、嵌套坐标、透明背景、锁定/隐藏和批量导出 |

## 7. Gate 与执行顺序

Phase 2 图层类型 Gate 只有在以下条件全部满足后才可通过：

1. 本文 8 类节点在兼容矩阵有独立结论；
2. 五类缺失节点完成 T0–T6，不以文档承诺或 UI mock 代替 Canonical 闭环；
3. Group 的空节点与 Relative-v1 Bounds P1 清零；
4. Line 固定端点和 Group 命中语义关闭；
5. UnknownNode/只读冲突已由 ADR 和总架构统一；
6. 固定 Fixture、迁移、服务重放 Hash、导出和人工验收全部通过；
7. 无 P0/P1。

建议执行顺序：先修正现有 Group/Line 不变量并冻结 T0/T1；随后并行推进 Polygon/Star、Vector 和 Slice；Vector 稳定后实现 BooleanOperation；最后统一进入 T6，不把某一类的局部完成当作整个图层类型 Gate。
