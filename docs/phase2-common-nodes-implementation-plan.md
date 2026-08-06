# Phase 2 常见节点与 Stroke 对齐实施方案

- 状态：实施中（WP2 部分完成）
- 编制日期：2026-08-05
- 适用范围：Phase 2.1–2.4，以及 Phase 2.6–2.8 的 Stroke 前置能力
- 依赖基线：Phase 1 Gate 通过并形成 `verification/phase1/completion.md`
- 对齐口径：Figma Design 的公开 Plugin API 节点与属性语义

## 实施进度（2026-08-06）

### 常见节点能力矩阵（当前实现）

| 节点 | Stroke Align | 四边 Stroke | 圆角 / 平滑 | 图片填充 | Inspector 边界 |
| --- | --- | --- | --- | --- | --- |
| Frame | Inside / Center / Outside | 支持 | 支持 | 支持；Outside 网格在图片裁剪后绘制 | 可编辑 Clip content、几何、外观和描边 |
| Rectangle | Inside / Center / Outside | 支持 | 支持 | 支持 | 可编辑几何、外观和描边 |
| 完整 Ellipse | Inside / Center / Outside | 不适用 | 不适用 | 支持 | 可编辑几何、外观、描边和 Arc 参数 |
| Arc / Donut | 仅 Inside | 不适用 | 不适用 | 现有填充路径支持 | 不显示 Stroke Align；改回完整 Ellipse 后恢复 Align |
| Line / Arrow | 不适用 | 不适用 | 不适用 | 不适用 | Arrow 是 Line + 两端 Cap；可编辑端点、Cap、Join、Miter、Dash |
| Group | 不适用 | 不适用 | 不适用 | 不适用 | 仅结构、几何和图层属性；不暴露 Fill、Stroke、Paint Stack、圆角 |
| Section | 仅 Inside | 不适用 | 支持 | 当前导入目标不支持 | 可编辑 Hide contents、几何、外观和圆角 |
| Text | 不适用 | 不适用 | 不适用 | 不适用 | 可编辑基础 Fill、线性渐变、Opacity；不暴露 Stroke / Paint Stack |

“支持”表示 Canonical、Core/WASM、Canvas 与 Inspector 已贯通；复杂的四边 Weight、虚线、Corner Smoothing 或资产导出仍可能明确走 Canvas/SVG fallback，不能据此视为完整同源 Outline Gate 已关闭。

已完成的可用闭环：

- `Line` 与 `Arrow Tool`：Arrow 以 `Line + StrokeCap` 表达；Line 在 Inspector 中仍是零高度几何，Legacy `x/y` 明确为第一个端点、旋转以该端点为局部原点。画布选中/悬停框、空间索引、culling 和多选联合 Bounds 共同使用包含实际 Stroke、圆/方端点和端点装饰的 world visual bounds，避免旋转或矩阵投影后偏离路径。culling 与选中覆盖层以稳定 NodeId 关联独立生成的投影，因而 Relative-v1 子树仍会绘制紧贴实际描边的旋转细选中框、端点控制点和零高尺寸标签。实线的 Canvas fallback 与 SVG 导出共用同一份“矩形主体 + 按需圆/方 Cap”的填充轮廓模型，避免两端 Cap 几何各自计算；虚线的非对称 Cap 则在 Canvas 与 SVG 均明确保留 Butt 降级，绝不把起点样式套用于每一段 dash，选框和精确命中也会移除相应的圆/方端点延伸。选中后显示两个端点手柄，可保持另一端不动地改变长度和角度，并以单一 Core 更新提交；显式 `relativeTransform` Line 会先逆变换到 local point，再通过 `relativeTransform × translate × rotate` 重写局部基，因此不丢失父级旋转、斜切或镜像。零长度仍收敛为 4px 的当前 Phase 2 最小长度。旋转、命中、端点样式、Snapshot/Operation/WASM 投影已打通。
- `F-PHASE2-COMMON-NODES` 保存与恢复回归：完整 Fixture 会经 `resolveCoreBatch` 生成 Create 批次、再经真实 Protobuf `ResolvedOperationBatch` 编码/解码，逐一核对全部常见节点的 NodeKind、父子关系和几何，并覆盖 Rectangle 的缺省统一圆角归一为 `0`、四角/四边 Stroke、Ellipse Arc、Line 的零高度与端点/虚线、Frame Clip、Section 内容隐藏和 Text 内容。Rust/WASM 测试还以同一 Fixture 验证浏览器展示层 `radius`→Canonical `cornerRadius` 的适配后，完整 Core 文档可经过服务端共享的 Protobuf Snapshot、再经过浏览器本地 JSON Snapshot 恢复，三端 Canonical Hash 完全一致。
- Phase 2 性能证据：浏览器的 Pointer/Wheel 输入以 Unix epoch 毫秒随 v3 可转移输入批次传递；Worker 在完成该批次的绘制后，以同一绝对时钟记录 `inputToRenderP95Ms`。固定 Fixture 采集器会在单一稳定会话中完成至少三轮、每轮 64 个交替 Pan 输入，写入 render、输入队列和 input-to-render 的 P95 摘要；`pnpm evidence:phase2-common-nodes-stability` 还会在同一 Fixture 会话中默认持续 3,600 秒，并保存每轮输入证据、console 与起止截图。源码冻结候选 `output/phase2-common-nodes/stability-20260806T014459Z/` 已完成 183 轮：console 0 error，Render P95 `1.01ms`、Input-to-render P95 `19ms`、输入队列 P95 `16.99ms`，均低于本地阈值。两者都只产生本地候选；`<50ms` 不能替代独立审核。
- `F-PHASE2-COMMON-NODES` Golden 候选采集：`pnpm check:phase2-common-nodes-fixture` 会冻结该 Fixture 的 SHA-256、节点顺序、层级、Arrow 的零高/两端 Cap 及 Rectangle 的独立圆角/四边 Stroke；`pnpm evidence:phase2-common-nodes` 以固定 `1440×960`、DPR `1` 的浏览器会话输出截图、readiness、console、环境与 SHA-256 元数据。采集结果严格标记为 `pending-independent-review`，只有独立审核者冻结 baseline 后才可计入正式 Golden Gate。
- `Group` 的基础结构：`parentId + PositionId` 已进入 Core、Protobuf、WASM、服务端适配和浏览器投影；Group/Ungroup 为单一事务，子节点保持当前世界坐标。
- Group 支持嵌套：选中已有 Group 与同级 Shape/Group 后执行 Group，会在最近共同容器下创建新的外层 Group，并保持原 Group 的完整子树不变；祖先与其已选后代不会重复打包，避免形成循环。
- `⌘/Ctrl+D Duplicate`：复制以选中根节点为单位；复制 Group、Frame 或 Section 时会在同级创建一个新容器，并递归复制完整子树、为每个内部节点生成新 ID 和重映射后的 parentId。若同时选中了祖先和后代，只复制一次祖先子树；复制后只选中新根节点。Legacy world-space 后代与 Relative-v1 后代都会跟随同一 24px 画布偏移，不会在原 Group 内额外创建空 Group 或遗失 children。
- Group 操作现在同时出现在左侧 Layer Panel 与右侧 Inspector：多选两项可执行 `Group`（`⌘/Ctrl+G`），单选 Group 可执行 `Ungroup`（`⇧⌘/Ctrl+G`）。快捷键由 Worker 解析为同一条 Canonical command，因此按钮与键盘拥有相同的事务、Undo/Redo 语义。
- 图层树展开/收起第一切片：Layer Panel 以稳定的父子深度构建虚拟化树；Frame、Group、Section 的容器行提供带 `aria-expanded` 的展开/收起按钮。收起时完整后代从可聚焦行、键盘导航与 DOM 虚拟窗口中移除；循环历史数据仍会以一次根行保留可检查性，不会使列表失效。层级行还支持 Figma 式键盘导航：`←` 收起当前容器或回到父级，`→` 展开当前容器或进入首个子级。
- 图层树以“父级在前、子级紧随其后”的结构顺序渲染，并只在每个同级集合内按视觉前后排序；不再对完整树作全局倒序，因此 Frame、Group、Section 不会被自身子项排到上方。
- Group 不变量：边界由直接 children 的世界空间 Bounds 派生；子节点几何或父级变动会重算；最后一个 child 移走或删除时自动解散，且与 Undo/Redo 同属一条 HistoryItem。
- Group 移动不变量：Group 的纯平移由 Group 本身承载，Relative-v1 子树随父级变换整体移动；只有不继承父级变换的历史 world-space 子项才被额外平移。Group 的宽高与旋转仍始终由 children 派生，禁止直接编辑。Core 回归会同时移动一个 Group 并断言另一 Group 及其子树坐标完全不变。
- Group 命中与下钻：普通点击 Group 子树中的可见、未锁定 child 时，画布选择最近的 Group（点击 Group 自身的 derived bounds 也保持选择该 Group）；双击同一 child 时通过输入批次的 `drillDown` 标记绕过该容器，选择实际 child。嵌套 Group 从内到外逐层生效，循环或缺失 parent 会安全回退到直接命中节点；锁定/隐藏 Group 不会拦截 child。这样可先对完整 Group 移动、缩放或检查属性，再通过双击进入 Shape/Text 等子元素，文本双击编辑语义保持不变。
- 层级删除：浏览器会将容器删除解析为稳定的子节点优先 Core Batch，避免孤儿节点，并让 Group 的自动解散参与同一事务。
- `Section`：新增 Section 工具、节点类型与图层图标；`contentsHidden` 可在 Inspector 独立切换，纯 Section 多选也会以 `Same`/`Mixed` 批量切换。隐藏后仅抑制 descendants 的渲染/命中，不影响 Section 本身；Canvas 的空间索引候选集会再次与层级可见性求交，因此隐藏子树不会在 culling 快路径中重新出现。该状态已进入 Core Hash、Snapshot、Operation、WASM 与服务端重放。
- Stroke 第一切片：`Join`、`Miter limit` 与 `Dash pattern` 已进入 Core、Protobuf、Snapshot、Operation、WASM 和 Inspector；奇数 Dash 会在 Canonical 边界展开为偶数周期，Canvas 渲染与 Line 精确命中共享该规则。该切片暂不包含 Stroke Align、四边独立权重、Rust Outline/Tessellation 或导出。
- Transform Dual-read：`relativeTransform` 已作为可选 2×3 仿射矩阵贯通 Core、Protobuf、Snapshot、Operation、WASM 和浏览器投影；旧记录仍以 `x/y/rotation` 读取。Core 与协议会拒绝非有限或不可逆矩阵，Hash、Undo/Redo 和服务回放已覆盖该字段。独立、无 DOM 的 Affine 模块现以“父矩阵 × 子矩阵”的 Canvas 顺序解析层级，并在有矩阵时优先使用该值。Worker 已将平移、旋转、正向缩放矩阵统一投影到世界空间；斜切和镜像则保留局部几何，并直接以其完整 world matrix 绘制 Canvas。两条路径共同覆盖空间裁剪、选中框、Hover、命中和框选；含原生矩阵的图层会终止 GPU 前缀，保留该层及其后续图层在 Canvas 以维持 z-order。Group/Ungroup 与通用 `reparent` 已写入 `parentInverse × oldWorld`，并由 Core 以同一套 world bounds 维护 Group 边界。图层面板支持将图层拖至 Frame、Group 或 Section 的中部完成跨父级移动，拖至行边界或空白处仍为同级排序；祖先/后代同选、跨 Page、循环和不可逆父矩阵均在单一事务中拒绝。
- Stroke 第二切片：Frame/Rectangle 的 `top/right/bottom/left` 四边独立权重已进入 Core、Protobuf、Snapshot、Operation、WASM、Canvas 与 Inspector；空数组继续表示原有的统一 `strokeWidth`。Line 等不适用节点会在 Canonical 边界拒绝该属性。该切片仍遵循现有的 Inside Canvas 投影，完整 Align/Outline/导出将在后续统一几何实现中接入。
- Stroke 第三切片：Frame/Rectangle 的 `Inside`、`Center`、`Outside` 对齐模式已经从 Canonical 属性贯通至 Canvas 和 Inspector；四边权重会随当前对齐模式投影，Inside 的每一边会向内偏移自身半个宽度，保证完整 Weight 位于形状内，并由 Canvas/SVG 共用位置计算。该实现覆盖画布可视几何，尚未替代 Rust Outline/Tessellation 与完整 Rounded-corner 退化规则。
- Ellipse Stroke Align 补齐：完整 Ellipse 现同样支持 `Inside`、`Center`、`Outside`，并由 Core/WASM 校验后持久化。Canvas 与 SVG 对 Inside/Outside 都以“外椭圆 Stroke Paint + 内椭圆 Fill Paint”的环形几何绘制；Center 仍使用标准居中描边。图片填充的完整 Ellipse 也消费同一环形几何：Outside 先画在图片遮罩之后的底层，Inside 以 even-odd ring 覆盖在图片上，Center 使用非裁剪的原生描边；Frame/Rectangle 图片填充仍保留其既有裁剪行为。无图片填充的完整 Ellipse、以及 uniform Stroke/圆角的 Frame/Rectangle 的 Center/Outside 现由 Rust 预计算实例和 WebGPU 扩展 Quad 绘制；四边 Weight、独立圆角、Corner Smoothing、Arc/Donut 与图片填充保持 Canvas 降级。精确 Hit Test 也随视觉外延扩展。Arc/Donut 因其开口和内径端点的 Stroke 语义尚未定义，继续只允许 Inside，Inspector 不展示该控件；若用户把已对齐的完整 Ellipse 改为 Arc，浏览器会在同一 Canonical Appearance 更新内自动重置为 Inside，不会先触发一次非法状态。
- Closed-shape Visual Bounds 补齐：完整 Ellipse、Frame 与 Rectangle 的 Center/Outside Stroke 外延现在通过共享 local envelope 同时驱动 Canvas culling、选中/悬停框、Resize 手柄、WebGPU Quad、多选缩放 Bounds 与 SVG 导出 viewBox；Frame/Rectangle 会按 Top/Right/Bottom/Left 的当前 Weight 分别外扩，未设置时回退为统一 Stroke Width。统一描边配合独立圆角时，精确 Hit Test 也会把每个圆角半径按视觉外延同步增长，避免画出来的圆角描边无法选中。Line 仍保留其独立的精确 Cap/Marker Bounds。旋转形状的 Bounds 有意采用保守的仿射外接矩形，保证可见 Paint 不会被裁剪；Arc/Donut 继续以自身几何 Bounds 为准。
- Rust Stroke Geometry 基础切片：`editor-core::geometry` 现提供独立于 Canvas/SVG 的 `stroke_mesh_for_polyline`，把任意开放或闭合 polyline 规范化为有界的确定性三角网格，并支持 Butt/Round/Square cap 与 Miter/Bevel/Round join、miter limit、重复点和单点退化；`stroke_mesh_for_dashed_line` 会按零偏移 Dash Pattern 分割可见直线段，并在每段上保留同一 Cap 几何；`stroke_mesh_for_dashed_polyline` 会把跨越折点的连续可见 Dash 保持为同一 Join，而 Gap 拆分为独立 Cap；`stroke_mesh_for_rounded_rectangle` 及其 Dash 变体支持统一或 TL/TR/BR/BL 独立 Radius 的闭合圆角中心线，并在相邻圆角恰好占满一条边时消除零长度退化段；连续 Corner Smoothing 则使用与 Canvas 相同的 `2 + smoothing × 6` 超椭圆指数及 `8..16` 分段采样进入同一 Mesh 边界。旧的 Core `stroke_hits_polyline` 已改为消费同一网格，避免命中规则另写距离近似；这些网格现经严格验证的 WASM 只读投影暴露给浏览器侧，Canvas 对普通非虚线、以及对称 Butt/Round/Square 端点的虚线 Line，和非极小尺寸、Inside/Center/Outside 对齐且统一粗细的直角、统一圆角、独立圆角或 Corner Smoothing Frame/Rectangle 已直接消费网格；直角、统一 Weight 的 Frame/Rectangle 虚线同样会由该闭合 polyline Mesh 绘制，圆角/独立圆角/连续角虚线也由同一归一中心线的 Dash Mesh 绘制。同一网格也会在图片裁剪结束后覆盖到该类 Frame/Rectangle，保证 Outside 不会被图片遮罩裁掉。虚线 Line 的可视 Bounds 会只在首/尾端实际存在 Dash 时外扩 Cap，避免末尾空隙被 Figma 式选中框误判。直角、无平滑角的 Frame/Rectangle 四边独立 Weight 现在也由 Core 计算 Top/Right/Bottom/Left 的 Inside/Center/Outside 中心线，并以有序的四条 Butt Mesh 经 WASM 交给 Canvas 叠加；设置 Dash 时每条独立边从零相位开始，保持原有分边 Paint 合成语义。圆角或平滑角的四边 Weight 与其他复杂 Dash 仍可靠回退 Canvas。WASM 更新会保留已绑定的图片资源；后续修改圆角平滑度或 Stroke Align 不再错误拒绝。完整 Ellipse 以及 uniform Stroke/圆角 Frame/Rectangle 的 Center/Outside 现由 Rust 预计算的扩展外接 Quad 与 WebGPU 环形绘制；Arc/Donut 和详细的 Rectangle/Frame Outline 继续留在 Canvas。其余 WebGPU、独立圆角/四边权重与 SVG 的统一网格消费尚未接入，仍属于后续统一接入工作。
- Ellipse Arc/Donut 第一切片：`startingAngle`、`endingAngle`、`innerRadius` 已以可选 ArcData 进入 Core、协议、Snapshot、Operation、WASM、Inspector、Canvas 与精确 Hit Test；无 ArcData 的既有椭圆保持完整 ellipse 语义与兼容 Hash。
- Frame 裁剪第一切片：含后代的 Frame 现在按结构树在 Canvas 中绘制，其圆角边界会裁剪 descendants；命中测试同步拒绝落在任一 Frame 裁剪区域以外的子节点。`clipsContent` 现作为 Frame-only 的可选 Canonical 字段贯通 Protobuf、Snapshot、Operation、Core、WASM、服务回放与 Inspector；缺失字段按 Figma 默认值 `true` 迁移，新 Frame 也默认开启，明确 `false` 可保存、Undo/Redo 和同步。裁剪建立后会将 Canvas 绘制变换复位至 world/device 坐标，避免嵌套 Frame 将父变换重复应用而让子内容与选框错位。为保证剪裁与文档层级顺序，存在启用裁剪 Frame 的页面会回退到 Canvas 绘制，不混入 GPU 前缀。复杂 Auto Layout/Resize 和导出仍待完成。
- Section 标题与 Resize 第一切片：Section 与 Frame 共享画布标题渲染、旋转/仿射投影和标题区域的优先命中；未选中时显示层名，选中时标题与选择标记同色。Section 的宽高通过基础 Geometry 独立更新，Core Batch 不会改写 descendants 的矩阵、几何或其世界位置，且不引入 Frame 的裁剪或约束传播。
- 通用 Transform 画布 Resize 第一交互切片：单选 Frame、Section、Rectangle、Ellipse、Text 和 Image（含 Legacy 嵌套节点与显式 `relativeTransform`）会显示 Figma 风格的八个缩放手柄；手柄拖拽在节点局部轴上计算，旋转、斜切或镜像矩阵会先逆变换到节点局部坐标，再以 `relativeTransform × localTranslation` 保持对侧锚点。角手柄按住 Shift 会保持原比例，按住 Alt/Option 会以中心缩放；两个修饰键在拖拽过程中可动态切换，并在 pointer-up 还原临时投影后提交唯一的 Canonical `UpdateGeometry`。输入二进制通道已传递 `altKey`，不影响只读标志或批处理边界。因此 Frame 的直接 child constraints 会由 Rust Core 在同一事务中传播、可撤销并同步到服务端；Section 仍按其语义只改变自身。多选已覆盖 Rectangle、Ellipse、Text、Image、Line、Frame、Section：画布显示一组统一八手柄，按该选择 Bounds 缩放全部节点，并以一笔 Core Batch 提交。Line 使用包含 Stroke、Cap 与端点装饰的实际 world bounds 参与联合 Bounds；旋转或矩阵 Line 与其他旋转/矩阵叶节点一样通过世界空间 Selection Scale 和 `parentInverse × newWorld` 写回精确 Relative-v1 矩阵。多选中的 Frame/Section 不仅重写矩阵：它们会同时写入缩放后的本地 `width/height`，再用补偿后的 Relative-v1 matrix 保持精确世界结果，因此 Frame Constraints 仍会在同一 Core Transaction 内执行。选中 Group 时，Worker 会递归展开其完整可编辑子树（包括 Frame、Section 与其 descendants），按父级在前的顺序把容器尺寸/补偿矩阵和 descendant 世界变换放入同一 Core Batch；Core 可先传播 Frame Constraints，最终 child 的显式相对矩阵仍精确落在 Group Scale 的世界结果，Group Bounds 则继续由 Core 派生。Group 与其被选 descendant 的重叠选择只缩放 Group 子树一次。Frame 与其被选 descendants 的重叠选择会隐藏统一手柄，避免 Frame Constraints 与显式 child resize 冲突。未旋转 Legacy 选择保留传统 Geometry 写入；只要叶节点中有旋转或显式矩阵，Worker 就以世界空间 Selection Scale 映射每个节点，再用 `parentInverse × newWorld` 写回精确 Relative-v1 矩阵，避免以 AABB 近似其仿射几何。
- 通用 Transform 画布 Resize 补充切片：所有当前常见节点（Frame、Section、Rectangle、Ellipse、Text、Image、Line）在无 Shift/Alt 的单选**和多选**手柄拖拽中允许越过对侧锚点，并以**始终为正**的 `width/height` 与 Relative-v1 反射矩阵表达 Figma 式镜像；旋转 Inspector 反映该镜像的等效角度，Undo/Redo 与远端 Operation 保持可回放。多选 Legacy 节点以反射后的 selection coordinates 写入正 Geometry，旋转/矩阵节点和容器则用带负轴的 world selection matrix 回投到各自 parent。容器的 child 保持自己的 local coordinates，因此父级反射会镜像完整子树；Frame 的新正尺寸仍按既有 Core Transaction 驱动 constraints，Clip 则继续在反射后的 Frame 范围内约束子内容。Shift/Alt 的锁比例和中心缩放维持既有最小尺寸规则，暂不引入跨越翻转。
- 四角圆角第一切片：`cornerRadii` 以 `TL/TR/BR/BL` 四个非负有限值进入 Frame、Rectangle、Section 的 Core、Protobuf、服务端 Snapshot/Operation、WASM 和浏览器投影；缺失或空数组继续读取既有的统一 `cornerRadius`，因此旧记录和 Hash 保持兼容。v1–v16 缺失该字段时稳定迁移为统一半径；Corner Smoothing 与 Paint Stack 随后将 JSON Core Snapshot 升级到 v19。Canvas 填充、图片裁剪、Frame 裁剪、Inside/Center/Outside Stroke、四边独立 Stroke 的裁剪路径，以及精确命中都消费同一组归一化半径；Inspector 可分别编辑四角，也可以还原为统一半径。Core 覆盖类型限制、非法值、Hash 与 Undo/Redo，协议和浏览器单测覆盖传输与命中。
- Corner Smoothing 第一切片：Frame、Rectangle、Section 现支持范围为 `0..1` 的 `cornerSmoothing`；Core 和协议拒绝非有限值、越界值与不适用节点，JSON Core Snapshot 曾升级到 v18，现随 v19 的 Paint Stack 扩展保持兼容；旧 v1–v17 记录默认平滑度为 `0`。Canvas 将平滑值映射为连续超椭圆角路径；该路径同时用于填充、图片与 Frame 裁剪、Inside/Center/Outside Stroke、四边 Stroke 裁剪和精确命中，Inspector 可滑动编辑或还原为圆角。SVG 的 Shape 和 Frame Clip 会使用同一指数与分段数输出连续角路径，避免导出退化为普通圆弧；Rust Outline 的逐像素几何一致性仍归入后续 WP5/WP7 Gate。
- Paint Stack 第三切片：`fills[]` 与 `strokes[]` 现以有序、最多 16 层的 Canonical `Paint` 数组贯通 Core、Protobuf、Snapshot、Operation、WASM、服务端适配和浏览器投影；空数组继续严格表示既有的单一 `fill/stroke` 字段，因此旧记录、旧 Hash 与现有 Inspector 操作保持兼容。Frame、Rectangle、Section、Ellipse/Arc 的填充和描边，以及 Line 的描边，在 Canvas 按数组顺序合成；含 Paint Stack 的图层会回退到 Canvas，以保持 GPU/Canvas 混合渲染的正确 z-order。Inspector 可将单一颜色无损转换为栈、增删图层、编辑每层 CSS 色值或还原为单一值；每个栈层还可切换 Solid/Linear gradient、编辑方向与有序色标，新增层会保留上一层的完整 Canonical Paint。线条不暴露填充层。当前页可直接导出 SVG：导出复用世界矩阵、Frame 裁剪与有序 Paint Stack，并覆盖 Frame/Section/Rectangle、Ellipse/Arc/Donut、Line/Arrow、Text；Line 的导出范围会与画布选框共用包含 Stroke、Cap 与端点装饰的 world visual bounds，避免旋转或极粗描边被 SVG viewBox 裁掉；无虚线 Line 的独立 Start/End Round/Square Cap 会由 Canvas 同源的单一 SVG 填充轮廓导出，避免 `stroke-linecap` 把起点样式错误套用到终点或让半透明重叠变深；显式 Solid Color 的 alpha 会以独立的 SVG fill/stroke opacity 与节点整体 opacity 组合；Frame/Rectangle 的统一粗细 Inside/Outside Stroke 会在实线时导出为等效 Paint Ring、在虚线时导出为已按 Align 偏移的虚线中心线路径，四边 Weight 则按当前 Align 分四条边导出。图片资产不会嵌入，改以向量 fallback 并给出提示。JSON Core Snapshot 升级到 v19，旧 v1–v18 记录默认空数组。PDF、图片内嵌以及 Rust Outline/Tessellation 的完全同源导出仍属于后续工作。
- Text Fill 补齐：Text 的单选 Inspector 现提供基础 Fill、Linear Gradient 与 Opacity；Text 仍不展示 Stroke 或 Paint Stack（当前文字绘制只消费单一 Fill）。使用渐变时，GPU Glyph Atlas 会明确将该 Text 及其后续图层留在 Canvas，确保编辑后的渐变不会被旧的实色 GPU 位图覆盖。SVG 导出同样消费该单一 Fill，并保留换行、Left/Center/Right 对齐、行高、段落间距；混合 Style Run 会按 UTF-8 字节范围输出 `tspan`，保留每段的字号、字重、斜体与字距。复杂逐 run shaping、精确字距定位与 RTL/BiDi 排版仍明确属于 Partial。
- Frame Constraints 第二切片：`min/center/max/stretch/scale` 已作为可选双轴 Canonical 属性进入 Core、Protobuf、Snapshot、Operation、服务端、WASM、浏览器投影与 Inspector；缺失字段保留旧文档的无约束语义，Group/Section 在 Core 被拒绝写入。Inspector 只在直接位于 Frame 中、或仅经过 Group 嵌套的可绘制节点上显示和批量写入该属性；根节点、Section 子树、Group/Section 和循环/缺失祖先明确视为 NotApplicable，避免将无效的 Figma 控件暴露给用户。轴对齐的 Legacy Frame 会在同一 Core Transaction 中更新直接 child 及其 Group descendants；Relative-v1 子树则统一在 Frame 局部坐标计算，因此可覆盖旋转、斜切或镜像 Frame 与显式矩阵 child（包括经过显式矩阵 Group 的 descendants）。受影响 Group 的派生 Bounds、矩阵变化、几何变化与 Undo/Redo 均在同一条 HistoryItem。尚未迁移到矩阵的 Legacy child 在旋转/仿射 Frame 下仍保持原状，Auto Layout 也尚未接入；这两项不得被当作已完成的 Figma 对齐。
- Mixed Inspector 与键盘导航第五切片：多选不再复用首个节点的伪单选 Inspector；当前对所有节点适用的 Rotation、Opacity、Visible 和 Lock 会显式显示 `Same` 或 `Mixed`，只有用户输入的新值才会覆盖。`fill`、`stroke width`、`stroke align`、四边 Weight、四角 Radius、Stroke details、Frame Clip 和 Section Hide contents 的多选可用性已收敛到同一能力矩阵：控件只会在全体节点都可安全写入时显示，其余情况以明确 NotApplicable 提示替代。Frame、Rectangle、完整 Ellipse 可编辑 Align，Arc/Donut、Section 和非闭合节点不会显示该控件；独立 Weight 仅适用于 Frame/Rectangle。四边 Weight 会先将每个节点的 uniform width 展开后逐侧比较；用户修改其中一侧时，其他 Mixed 侧保持各节点原值，避免批量编辑静默覆盖。全体为 Frame/Rectangle/Section 时也会显示四角 Radius，并采用相同的逐角保留策略，同时支持 `0..100%` Corner Smoothing 的 Same/Mixed 批量编辑或还原为圆角。排除 Group/Section 后，任意可绘制节点的双轴 Frame Constraints 也会逐轴显示 `Same`/`Mixed`/`No constraints`；编辑一轴时会保留每个节点另一轴的现有值，Legacy 无约束节点只会在用户选择具体约束后才补为显式 `min`，并可一键移除显式约束以恢复旧语义。全体为可绘制节点时会显示 Join、Miter limit 与 Dash Pattern；Start/End Cap 仅在全体都是 Line 时出现。所有字段均以 `Same`/`Mixed` 呈现，Dash 复用单选的有限非负校验与奇数周期展开，且不会把不适用属性写入 Group/Text。全体选中节点均为单层 Solid Paint 时，Fill/Stroke 可以批量覆盖；任一渐变或 Paint Stack 会明确要求单选编辑，避免复杂涂层被静默扁平化。一次多选修改通过同一个 Core Batch/Transaction 提交，因此服务重放、撤销和回滚保持原子。图层列表支持 Up/Down/Home/End 的可访问键盘导航，并在虚拟滚动后恢复焦点；Inspector 的单选/多选标题以 polite live region 播报选择变化；在图层行按 Tab 会缩进到前一同级容器，Shift+Tab 则提升一层，二者复用 Canonical Reparent 以保留世界位置；F2 在当前图层行进入行内重命名，Enter 提交、Escape 取消；Backspace 与 Delete 都会解析为同一条 Canonical Delete 命令。绘图工具快捷键选中后，按 Enter 会在当前视口中心创建相同的默认 Canonical 节点（Arrow 仍为 Line + ArrowLines），使创建流程也可完全用键盘完成。复杂 Geometry、NotApplicable 的完整能力矩阵仍属于 WP6 后续工作。

单选 Inspector 同样遵守这些能力边界：Group 是纯结构节点，只显示 Geometry 与 Layer，不能编辑 Fill、Stroke、Paint Stack 或圆角；Line 保留 Stroke Stack，但不会获得闭合节点的统一 Radius。该规则以独立能力函数和回归测试冻结，避免单选与多选出现相反的可编辑性。

仍未达成 Phase 2 完成标准：Paint Stack 的 Rust Outline/Tessellation 与完整导出一致性、完整的键盘层级交互、Mixed Inspector、Golden/性能 Gate。因此下文的“必须”和“建议”仍是剩余实施约束，不能将当前进度标记为 Phase 2 完成。

- Mixed Inspector Geometry 补齐：Canvas 八手柄与 Inspector 的多选 X/Y/W/H 现复用同一 world visual bounds 解析；输入任一字段会在一个 Core Transaction 中平移或缩放完整选择集，旋转/Relative-v1 节点按 parent-local 矩阵回写，Group 会递归展开可编辑子树，Line 采用真实 Stroke/Cap Bounds。
- 图层树鼠标多选补齐：Layer Panel 的 Shift、⌘/Ctrl 点击现在与画布的 additive selection 语义一致；从树中直接选择多个同级或跨层节点即可进入同一 Mixed Inspector，不会把已有选择替换掉。

## 1. 目的与结论

本文把 Phase 2 中 Frame、Group、Rectangle、Ellipse、Line、Arrow 和 Stroke 的需求整理为可直接开发、测试和验收的实施计划。

结论如下：

1. 常见节点可以在 Phase 2 与 Figma 的公开节点语义和主要编辑行为对齐；
2. Arrow 不新增独立 NodeKind，而是 `LineNode + strokeCap` 的工具预设；
3. Stroke 不是节点，而是 Frame、Rectangle、Ellipse、Line、Vector 等节点共享的外观和几何能力；
4. 在增加工具栏按钮之前，必须先完成层级事务、局部变换、Paint 数组和节点能力组合；
5. Phase 2 交付“Figma-aligned common nodes”，Figma REST 导入、Plugin Bridge 写回和 Round-trip 兼容性仍属于 Phase 3；
6. Phase 1 Gate 已作为本阶段前置条件通过；本文所列的剩余约束仍必须在 Phase 2 完成前逐项验收。

## 2. 背景与当前状态

现有架构已经具备以下可复用基础：

- 稳定 `NodeId`、`PageId` 和不可复用 Tombstone；
- `parent_id + PositionId` 的 Canonical 层级基础；
- 原子 Transaction、单调 revision、Undo/Redo 和 Canonical Hash；
- Worker 驱动的画布、命中和渲染投影；
- Frame、Rectangle、Ellipse、Text 的基础创建和渲染；
- Solid、Linear Gradient、图片资源和基础 Stroke 投影；
- 版本化 Protobuf Snapshot 和 Operation。

但当前实现不能直接承载完整 Phase 2 节点语义：

- Rust `NodeKind` 只有 Frame、Rectangle、Ellipse、Text、Image；
- Web `CanvasNode` 没有 `parentId`，Worker 和图层树无法消费真实嵌套关系；
- `SetNodePosition` 只能改变同一父级下的顺序，不能原子改变父级；
- 删除包含子节点的容器会返回 `NodeHasChildren`；
- Geometry 仍是扁平的 `x/y/width/height/rotation`；
- Fill 和 Stroke 各只有一个 Paint，与 Figma 的 `Paint[]` 不一致；
- 统一的正宽高约束不能表达 Figma 高度恒为 0 的 Line；
- Stroke 缺少 Align、Cap、Join、Dash、Miter 和四边独立粗细。

因此，Phase 2 的第一项工作应是扩展 Canonical 能力模型，而不是直接添加 Group、Line 或 Arrow 的 UI。

## 3. 范围边界

### 3.1 本方案包含

- Frame 的容器、裁剪、圆角、Stroke 和嵌套语义；
- Group/Ungroup、非空 Group、派生 Bounds 和子节点保持视觉位置；
- Rectangle 四角独立圆角和 Corner Smoothing；
- Ellipse、Circle、Arc 和 Donut 的统一节点表达；
- Line 的创建、编辑、零高度几何、Stroke 命中和导出基础；
- Arrow Tool 到 Line + StrokeCap 的映射；
- Section 的基础容器和内容隐藏语义；
- `fills[]`、`strokes[]`、Stroke Align/Cap/Join/Dash/Miter；
- Frame/Rectangle 四边独立 Stroke Weight；
- 嵌套图层树、跨父级移动、子树删除和恢复；
- 局部/世界坐标转换，以及常见节点所需的基础 Transform；
- 单选和多选 Mixed Inspector 的相关属性；
- Snapshot/Operation 迁移、服务端对账、Undo/Redo 和兼容性 Fixture。

### 3.2 本方案不包含

- Figma REST 文件导入和 Plugin Bridge 写回；
- Component、ComponentSet、Instance 和 Overrides；
- Styles、Variables、Collections、Modes 和 Alias；
- 完整 Pen Tool 和任意 Vector Network 编辑；
- Boolean Operation 的完整几何算法；
- Mask、Blur、Blend Mode 和完整 Effect 合成；
- Auto Layout 的完整布局算法；
- 多人并发合并、Presence、评论和协同 Undo；
- `.fig` 私有文件格式读写。

这些能力分别由 Phase 2 后续步骤、Phase 3 或 Phase 4 负责。

## 4. Figma 对齐原则

### 4.1 对齐层级

Phase 2 使用以下三层口径：

1. **节点语义对齐**：相同概念使用可确定映射的 NodeKind 和属性；
2. **编辑行为对齐**：创建、嵌套、移动、Resize、删除和属性修改符合用户预期；
3. **数据交换就绪**：Canonical 数据不阻断 Phase 3 Adapter 的无损或有报告映射。

Phase 2 不以“字段名称完全复制 Figma”为目标。内部结构可以不同，但必须能稳定映射，且不支持项必须保留或报告，不能静默丢失。

### 4.2 Supported 的定义

一个节点或属性只有同时满足以下条件才可在兼容矩阵中标记为 `Supported`：

- Canonical Schema 可表达；
- Operation 可创建和修改；
- Snapshot 可保存、迁移和恢复；
- Worker 可投影；
- Canvas/WebGPU 或明确的正式降级路径可渲染；
- Hit Test 和选择结果正确；
- 图层树和 Inspector 可编辑；
- Copy、Duplicate、Delete、Undo、Redo 可用；
- 服务端重放后 Document Hash 一致；
- 导出或兼容性报告有确定结果；
- 自动 Fixture 和人工验收通过。

只有 Schema 或渲染支持的能力最多标记为 `Partial`，不能伪装为完整支持。

## 5. 节点和属性映射决策

| 产品元素 | Canonical NodeKind | Figma 对应 | Phase 2 决策 |
|---|---|---|---|
| Frame | `Frame` | `FrameNode` | 真实 children 容器，支持几何、外观、Clip、Constraints 和后续 Auto Layout |
| Group | `Group` | `GroupNode` | 只能由非空选择创建；Bounds 由 children 派生；空 Group 自动解散 |
| Rectangle | `Rectangle` | `RectangleNode` | 支持四角独立半径、Corner Smoothing、Fill 和 Stroke |
| Ellipse/Circle | `Ellipse` | `EllipseNode` | Circle 是宽高相等的 Ellipse；Arc/Donut 使用 `arc_data` |
| Line | `Line` | `LineNode` | `height == 0`；长度和方向由 size/transform 表达；主要外观来自 Stroke |
| Arrow Tool | `Line` | `LineNode + StrokeCap` | 不创建 `Arrow` NodeKind；工具只设置默认端点样式 |
| Section | `Section` | `SectionNode` | 组织画布内容；Resize 不传播普通 Frame Constraints；支持内容隐藏 |
| Polygon | `Polygon` | `PolygonNode` | Phase 2 图形后续工作包 |
| Star | `Star` | `StarNode` | Phase 2 图形后续工作包 |
| Vector | `Vector` | `VectorNode` | Phase 2 VectorPath/Pen 工作包 |
| Stroke | 非 NodeKind | Geometry/Stroke properties | 作为节点能力组合，不进入图层树 |

公开语义参考：

- [Figma FrameNode](https://developers.figma.com/docs/plugins/api/FrameNode/)
- [Figma GroupNode](https://developers.figma.com/docs/plugins/api/GroupNode/)
- [Figma RectangleNode](https://developers.figma.com/docs/plugins/api/RectangleNode/)
- [Figma EllipseNode](https://developers.figma.com/docs/plugins/api/EllipseNode/)
- [Figma LineNode](https://developers.figma.com/docs/plugins/api/LineNode/)
- [Figma StrokeCap](https://developers.figma.com/docs/plugins/api/StrokeCap/)
- [Figma strokes](https://developers.figma.com/docs/plugins/api/properties/nodes-strokes/)
- [Figma strokeAlign](https://developers.figma.com/docs/plugins/api/properties/nodes-strokealign/)

## 6. Canonical 数据模型

### 6.1 能力组合

不得继续让所有 NodeKind 共享一组不加区分的扁平字段。建议将 Canonical Node 拆成共享能力和类型专属属性：

```rust
struct Node {
    base: SceneNodeBase,
    geometry: Option<GeometryProps>,
    style: Option<StyleProps>,
    data: NodeData,
}

struct SceneNodeBase {
    id: NodeId,
    name: String,
    tree_location: TreeLocation,
    visible: bool,
    locked: bool,
}

struct TreeLocation {
    page_id: PageId,
    parent_id: Option<NodeId>,
    position_id: PositionId,
}

struct GeometryProps {
    relative_transform: Transform2D,
    size: Size,
    preserve_ratio: bool,
}

struct StyleProps {
    opacity: f32,
    blend_mode: BlendMode,
    fills: Vec<Paint>,
    strokes: Vec<Paint>,
    stroke: StrokeProps,
    effects: Vec<Effect>,
}

enum NodeData {
    Frame(FrameProps),
    Group(GroupProps),
    Rectangle(RectangleProps),
    Ellipse(EllipseProps),
    Line(LineProps),
    Section(SectionProps),
    Text(TextProperties),
    Image(ImageProps),
    Vector(VectorProps),
    Unknown(ExtensionPayload),
}
```

Phase 2 实现时可以分步迁移内部 Rust 结构，但 Protobuf 和 Hash 必须从一开始定义最终的确定表达，避免同一阶段反复改变持久语义。

### 6.1.1 Transform 持久化迁移契约（WP3 实施冻结）

当前已发布记录把 `x/y/rotation` 解释为世界坐标；`parentId` 只承担结构关系。WP3 不允许在同一字段上静默切换解释方式，必须按下表迁移：

| 阶段 | 读取 | 写入 | 语义 |
| --- | --- | --- | --- |
| Legacy | `x/y/rotation` | `x/y/rotation` | 世界坐标 |
| Dual-read | Legacy 或 `relativeTransform` | Legacy；Group/Ungroup/Reparent 写入 `relativeTransform` | 以小范围写路径验证无损校验与 Fixture 对照 |
| Relative-v1 | Legacy + `relativeTransform` | `relativeTransform` | 非 root 节点相对父级；root 相对 Page world |
| Cleanup（Phase 3 后） | `relativeTransform` | `relativeTransform` | `x/y/rotation` 仅作为 UI 投影，不能参与 Hash |

实现规则：

1. `relativeTransform` 是 2×3 仿射矩阵 `[a,b,c,d,e,f]`，坐标约定为 `x'=ax+cy+e, y'=bx+dy+f`；必须全部有限且 `abs(ad-bc) > 1e-12`。
2. 在当前 Dual-read 阶段，旧 Snapshot 没有该字段时，加载器继续把 `x/y/rotation` 当作世界坐标，`parentId` 仅承担结构关系；不得自动回填矩阵或改变旧 Hash。只有写入 Relative-v1 的节点才按父→子稳定顺序消费 `relativeTransform`；Cleanup 后才移除旧几何的 Hash 语义。
3. Reparent 必须在单一 Transaction 中以 `parentInverse × oldWorld` 生成子节点新矩阵；父不可逆、循环或跨 Page 一律在提交前拒绝，绝不能以近似数值继续执行。
4. Group Bounds、选框、Hit Test、Clip 与导出都只能消费派生 world matrix；它们不得写入 Snapshot，也不得由各渲染器各自重复实现。
5. 切换写入前必须冻结三层 Fixture：重复 Group/Ungroup、旋转 Parent 下 Drag/Resize、服务重放后 Undo/Redo。每个 Fixture 要断言矩阵、几何、父级、PositionId 与 Hash 均逐位稳定。

该迁移由 `scene-transform.ts` 的无 DOM Affine 实现先行验证；Core、WASM、Service 和 Worker 必须复用相同的 fixture 向量后才启用 Relative-v1 写入。

### 6.2 节点专属属性

```rust
struct FrameProps {
    clips_content: bool,
    corner_radii: CornerRadii,
    corner_smoothing: f32,
    constraints: Option<Constraints>,
    auto_layout: Option<AutoLayoutProps>,
}

struct GroupProps {
    expanded: bool,
}

struct RectangleProps {
    corner_radii: CornerRadii,
    corner_smoothing: f32,
}

struct EllipseProps {
    arc_data: ArcData,
}

struct ArcData {
    starting_angle: f64,
    ending_angle: f64,
    inner_radius: f64,
}

struct LineProps;

struct SectionProps {
    contents_hidden: bool,
    corner_radii: CornerRadii,
    corner_smoothing: f32,
}
```

### 6.2.1 Frame Resize 与 Constraints：已实施核心契约，保留验收边界

Figma 将 `constraints` 定义为图层在其包含 Frame 改变尺寸时的行为；每个轴独立取 `MIN`、`CENTER`、`MAX`、`STRETCH` 或 `SCALE`（界面分别称为 Left/Top、Center、Right/Bottom、Left & Right/Top & Bottom、Scale）。`Group` 自身不持有该属性，但 Frame resize 会继续对 Group 内的子图层应用其约束。该定义以 Figma Plugin API 为准：[Constraints](https://developers.figma.com/docs/plugins/api/Constraints/) 与 [constraints property](https://developers.figma.com/docs/plugins/api/properties/nodes-constraints/)。

第一实现切片必须采用如下 Canonical 表达，并保持缺失字段的旧文档兼容：

```rust
enum ConstraintType { Min, Center, Max, Stretch, Scale }

struct Constraints {
    horizontal: ConstraintType,
    vertical: ConstraintType,
}

// `None` 保留旧文档行为；Inspector 首次显式设置时写入 Some(Min, Min)。
Node { constraints: Option<Constraints>, .. }
```

规则如下：

1. 只允许 Figma 支持的可绘制节点写入该属性（Frame、Rectangle、Ellipse、Line、Text、Image）；`Group` 与 `Section` 拒绝写入。属性在非 Frame 父级下可保留但不生效，以使 reparent 与 Undo/Redo 不会丢失用户设置。
2. Frame 几何更新必须先捕获旧的 local width/height，并在同一 Core Transaction 内展开所有受影响后代的 Geometry/Transform 更新；预校验失败时整笔 resize 回滚，不允许父已变、子未变的中间状态。
3. 对任一轴，设旧父尺寸为 `P`、新尺寸为 `P'`、`Δ=P'-P`，子节点局部起点为 `p`、尺寸为 `s`：`MIN => (p,s)`，`CENTER => (p+Δ/2,s)`，`MAX => (p+Δ,s)`，`STRETCH => (p,s+Δ)`，`SCALE => (p·P'/P,s·P'/P)`。当 `P=0` 时拒绝 `SCALE` 的该次 resize，而不是除零或猜测结果。
4. 算法必须在 Frame 的**局部坐标系**运行：Relative-v1 节点用其到 Frame 的累计 `relativeTransform` 计算，旋转、斜切或镜像 Frame 仍用局部轴计算，再写回 child 的即时父级矩阵；对于任意经过的 Group，必须用其逆矩阵回投，不能以“调整 Group 外框”替代子层约束。仍处于 Legacy 世界坐标路径的 child 仅在轴对齐 Frame 下使用既有 `x/y` 规则；不得在旋转 parent 下按世界坐标近似。
5. 当前范围覆盖 Frame 的直接可绘制子节点和 Group descendants。Section resize 继续不触发这一算法；Auto Layout 一律排除，待单独 Layout Engine。
6. Protobuf 字段、Core Snapshot、Operation、WASM、服务端适配、Worker 投影和 Inspector 必须同步追加；Hash、字节预算与 Undo/Redo 以最终 `constraints` 和展开后的 child 几何为准。

最低验收 Fixture：普通 Frame 的五种轴组合；旋转或显式矩阵 Frame 下的相同组合；显式矩阵 Group descendant 的局部回投；含 Clip 的 Frame；跨父级 reparent 后保留设置；零尺寸 Frame 的 `SCALE` 拒绝；Legacy child 位于旋转 Frame 时明确保持不变；服务重放与 Undo/Redo 后 Hash 完全一致。

`expanded` 是否进入 Canonical Document 需要单独决策。若它仅表示当前用户图层树的展开状态，应进入用户 View State，而不是共享 Document。不得因为 Figma Plugin API 暴露该字段就直接持久化到多人共享文档。

### 6.3 Stroke 数据结构

```rust
struct StrokeProps {
    weights: StrokeWeights,
    align: StrokeAlign,
    cap_start: StrokeCap,
    cap_end: StrokeCap,
    join: StrokeJoin,
    miter_limit: f64,
    dash_pattern: Vec<f64>,
}

enum StrokeWeights {
    Uniform(f64),
    PerSide {
        top: f64,
        right: f64,
        bottom: f64,
        left: f64,
    },
}

enum StrokeAlign {
    Center,
    Inside,
    Outside,
}

enum StrokeCap {
    None,
    Round,
    Square,
    ArrowLines,
    ArrowEquilateral,
    DiamondFilled,
    TriangleFilled,
    CircleFilled,
}

enum StrokeJoin {
    Miter,
    Bevel,
    Round,
}
```

规则：

- `strokes` 是有序 Paint 数组；
- Line 默认 `fills = []`；
- Arrow Tool 默认创建 `cap_start = None`、`cap_end = ArrowLines`；
- 非开放路径的端点 Cap 可以保存，但渲染和 Inspector 应按适用性处理；
- 四边独立 Stroke Weight 首先只开放给 Frame 和 Rectangle；
- Dash 数组必须为有限、非负数值，并定义奇数长度数组的规范化规则；
- Miter Limit 必须为有限正数；
- Outline Stroke 使用相同 Stroke 几何算法，不能由导出器另写一套近似逻辑。

### 6.4 Line 几何不变量

现有“所有节点宽高必须大于 0”的不变量需要改为按 NodeKind 校验：

```text
Frame/Rectangle/Ellipse/Section/Text/Image:
  width > 0 && height > 0

Line:
  width >= 0 && height == 0

Group:
  size 为 children 的派生结果，不接受普通 SetGeometry 直接写入不一致值
```

建议第一版拒绝零长度 Line，即 `width == 0`，直到点状 Line 的 Cap、Bounds 和 Hit Test 语义被明确。

Line 的普通 Bounds 可以是零高度，但 Render Bounds 和 Hit Bounds 必须包含：

- Stroke Weight；
- Stroke Align；
- 起止 Cap；
- Arrowhead；
- rotation/relative transform。

## 7. Protobuf 与迁移策略

### 7.1 Append-only 扩展

既有 Protobuf 字段号不得修改或复用。建议在现有 `SceneNode` 后追加：

```proto
message SceneNode {
  // existing fields 1..21 remain readable
  repeated Paint fills = 22;
  repeated Paint strokes = 23;
  Transform relative_transform = 24;
  StrokeProperties stroke_properties = 25;
  NodeProperties properties = 26;
  map<string, bytes> extensions = 27;
}
```

Operation 同步增加类型明确的更新消息：

```proto
message MoveNode {
  bytes node_id = 1;
  optional bytes parent_id = 2;
  bytes page_id = 3;
  PositionId position_id = 4;
  Transform relative_transform = 5;
}

message SetPaints { ... }
message SetStrokeProperties { ... }
message SetNodeProperties { ... }
message DeleteSubtree { ... }
```

不得使用一个无类型的 `map<string, any>` 替代正式属性，因为它会削弱校验、Hash、迁移和生成类型的可靠性。`extensions` 只用于未知或尚未支持的 namespaced 数据。

### 7.2 旧字段迁移

Snapshot 新版本读取规则：

1. 若新 `fills` 字段存在，使用新字段；否则将旧 `fill` 迁移为单元素数组；
2. 若新 `strokes` 字段存在，使用新字段；否则将旧 `stroke` 迁移为单元素数组；
3. 旧 `x/y/rotation` 迁移为 `relative_transform`；
4. 旧 `width/height` 迁移为 `size`；
5. 旧 `stroke_width` 迁移为 Uniform Stroke Weight；
6. 旧 `corner_radius` 迁移为四角相同的 `CornerRadii`；
7. 缺少新节点专属属性时使用冻结的类型默认值；
8. 迁移后重新计算新版本 Canonical Hash；
9. 原始 Snapshot 保留，迁移失败不得覆盖旧数据。

需要冻结“透明旧 Paint”的迁移规则。推荐保留为透明 Paint，而不是迁移为空数组，以确保旧文档的 Canonical 意图不被猜测性改变。

### 7.3 兼容性测试

- 读取所有 v1–当前版本 Snapshot Fixture；
- 迁移结果通过 Document 不变量；
- 同一旧 Snapshot 重复迁移结果一致；
- 新 Snapshot 保存、刷新和服务恢复后 Hash 一致；
- 旧客户端遇到新 NodeKind 时明确拒绝编辑或进入只读，不得把未知节点改写为 Rectangle；
- Extension Payload 在读写往返后逐字节保留。

## 8. Command、Transaction 与历史

### 8.1 跨父级移动

新增原子 `MoveNodes` Command。每个移动至少携带：

- `node_id`；
- `new_page_id`；
- `new_parent_id`；
- `new_position_id`；
- `new_relative_transform`。

Reducer 在提交前统一校验：

- 节点、Page 和目标 Parent 存在；
- 目标 Parent 允许 children；
- 不能移动到自身或后代；
- 同一 Parent 下 PositionId 唯一；
- 跨父级移动后局部 Transform 有限且可逆；
- Group 不会因为本次移动形成非法空容器；
- 整个批次全部合法后才提交。

拖拽时保持视觉位置的计算流程：

```text
old world transform
  = old parent world transform × old relative transform

new relative transform
  = inverse(new parent world transform) × old world transform
```

矩阵不可逆或超出数值预算时，整笔 Transaction 必须拒绝。

### 8.2 Group/Ungroup

`GroupSelection` 是复合 Command：

1. 校验选择非空、节点可被重新父化且具有同一合法目标 Parent；
2. 计算选择节点的世界空间联合 Bounds；
3. 创建 Group；
4. 将 Group 插入原兄弟顺序的确定位置；
5. 将选中节点移动为 Group children；
6. 重算每个 child 的相对 Transform，保持世界视觉不变；
7. 单次 Transaction 提交并产生一个 HistoryItem。

`Ungroup` 执行逆过程，将 children 移至 Group 的 Parent 并保持视觉位置，然后删除 Group。Undo 必须精确恢复原 Group ID、PositionId 和 children 顺序。

空 Group 规则：

- 不提供 `CreateEmptyGroup`；
- 删除或移走最后一个 child 时，同一 Transaction 自动解散 Group；
- 该自动行为必须进入同一个 HistoryItem，不能产生隐藏的第二次 revision。

### 8.3 子树删除

新增 `DeleteSubtree`：

- 按稳定顺序收集目标节点和全部后代；
- 去重被多个选中祖先覆盖的节点；
- 原子写入 Tombstone、资源引用和文本/节点专属属性历史；
- 删除后的选择移动到确定的兄弟或 Parent；
- Undo 使用原 NodeId、parent、position、properties 恢复整棵子树；
- 超出 History 字节预算时在提交前拒绝。

### 8.4 Arrow Tool

Arrow Tool 只存在于工具和命令解析层：

```text
ToolKind::Arrow
  -> CreateNode(NodeKind::Line)
  -> Set strokes to default solid paint
  -> Set uniform weight to default
  -> Set cap_start = None
  -> Set cap_end = ArrowLines
```

Snapshot、Operation、图层树和 Phase 3 Adapter 中均不存在 `ArrowNode`。

## 9. Worker、渲染与命中

### 9.1 Scene 投影

Worker 投影必须包含：

- `parentId`；
- `positionId`；
- `relativeTransform`；
- 派生 world transform；
- `fills[] / strokes[]`；
- Stroke properties；
- 节点专属属性；
- Clip 和 ancestor visibility/lock 状态。

World Transform、Bounds 和 Children Cache 是派生数据，禁止进入 Snapshot。

### 9.2 渲染顺序

建议固定以下绘制流程：

1. 解析 active Page 的层级和稳定 z-order；
2. 计算 ancestor transform、opacity、visibility 和 clip stack；
3. 绘制 Fill Paints；
4. 绘制 Stroke Paints 和端点装饰；
5. 绘制 children 或按 Frame/Group 语义进入子树；
6. 绘制瞬态选择、控制柄和辅助线。

具体 Fill/Stroke 与 children 的合成次序需要通过 Golden 冻结，Canvas、WebGPU、SVG 和 PDF 不得各自猜测。

### 9.3 Stroke 几何单一来源

Stroke Tessellation/Outline 应由 Rust 几何层提供可复用结果，至少服务于：

- Canvas/WebGPU 渲染；
- 精确 Hit Test；
- Render Bounds；
- Outline Stroke；
- SVG/PDF 导出；
- Golden/几何 Fixture。

Canvas 2D 可以作为降级渲染器，但不能成为 Canonical Stroke 几何的唯一实现。

### 9.4 命中规则

- Frame/Rectangle：考虑 Fill、Corner、Stroke Align 和 Clip；
- Ellipse/Arc：使用椭圆/圆弧解析几何，不能只测矩形 Bounds；
- Line/Arrow：使用 Stroke 和端点装饰的实际几何命中；
- Group：命中 children；直接选择 Group 与深层选择通过交互模式区分；
- Section：标题和容器范围具有明确命中优先级；
- Hidden 节点不命中；Locked 节点遵循选择策略但不能进入编辑状态；
- Clip 外内容不参与正常命中。

## 10. 图层树与 Inspector

### 10.1 嵌套图层树

图层树从 Canonical `parentId + PositionId` 派生，禁止维护第二套 children 顺序。

需要支持：

- 多层 Frame/Group/Section；
- 折叠和展开；
- 重命名；
- 同父级排序；
- 跨父级拖拽；
- 非法成环拒绝；
- 显示/隐藏和锁定；
- 键盘移动、缩进、提升层级和状态播报；
- 大型树虚拟化和稳定焦点。

折叠状态优先存入用户 View State；只有明确需要跨用户共享时才进入 Document。

### 10.2 Inspector 适用性

Inspector 根据能力显示属性，而不是根据 NodeKind 写大量重复分支：

| 属性区 | 适用节点 |
|---|---|
| Transform | 所有具有 GeometryProps 的 SceneNode |
| Fill | Frame、Rectangle、Ellipse、Section、Vector、Text 等 |
| Stroke | Frame、Rectangle、Ellipse、Line、Section、Vector 等 |
| Corner | Frame、Rectangle、Section，以及支持顶点圆角的图形 |
| Arc | Ellipse |
| Clip Content | Frame |
| Auto Layout | Frame，后续 Component/Instance |
| Group | 只显示结构、Transform、Opacity 等适用能力 |
| Endpoint | Line 和开放 VectorPath |

### 10.3 Mixed 规则

多选属性读取返回：

```text
Same(value)
Mixed
NotApplicable
```

写入规则：

- `Same` 和 `Mixed` 都可以被明确的新值覆盖；
- `NotApplicable` 节点不接收该属性；
- 一次多选修改只生成一个 Transaction/HistoryItem；
- 若任一目标修改非法，默认整笔拒绝；只有产品明确支持 partial 时才允许部分成功并报告；
- UI 不能把 Mixed 显示值误提交为真实值。

## 11. 工作包与依赖

### WP0：Phase 1 Gate

交付物：

- `verification/phase1/completion.md`；
- CI、Golden、性能、稳定性和人工验收通过；
- Phase 1 Snapshot/Operation 基线冻结。

退出条件：Phase 1 Gate 为 `PASS`，无 P0/P1。

### WP1：Phase 2 Schema 与 ADR

依赖：WP0。

交付物：

- Node capability composition ADR；
- Transform/跨父级移动 ADR；
- Paint[]/Stroke ADR；
- Protobuf append-only 设计；
- Snapshot 迁移版本和 Fixture；
- TypeScript 生成类型更新。

退出条件：旧 Snapshot 全部可读，新 Schema 往返和 Hash 测试通过。

### WP2：层级事务

依赖：WP1。

交付物：

- `parentId` 全链路投影；
- `MoveNodes`；
- 成环检测；
- `DeleteSubtree`；
- Group/Ungroup；
- Undo/Redo 和服务端 Operation Adapter；
- 层级/顺序/恢复测试。

退出条件：跨三层 Frame/Group 移动、Undo、刷新和服务恢复后结构与 Hash 一致。

### WP3：Transform 基础

依赖：WP1、WP2。

交付物：

- relative/world transform；
- 跨父级保持视觉位置；
- 派生 Bounds；
- 旋转父级中的选择、移动和基础 Resize；
- 数值稳定和不可逆矩阵拒绝测试。

退出条件：固定嵌套 Transform Fixture 无漂移，重复 Undo/Redo 精确恢复。

### WP4：常见节点闭环

依赖：WP2、WP3。

交付物：

- Frame、Group、Rectangle、Ellipse、Line、Section NodeKind；
- Line/Arrow 工具；
- ArcData、CornerRadii、CornerSmoothing；
- 创建、渲染、Hit Test、图层树和基础 Inspector；
- Snapshot/Operation/Undo/Redo Fixture。

退出条件：每种节点完成本文第 12 节的节点验收矩阵。

### WP5：完整 Stroke

依赖：WP1、WP3、WP4。

交付物：

- `strokes[]`；
- Align、Cap、Join、Dash、Miter；
- 四边独立 Weight；
- Arrowhead；
- Outline Stroke；
- 统一 Render Bounds/Hit/Export 几何；
- 几何回归和 Golden。

退出条件：退化、相切、旋转、极粗描边和 Dash Fixture 全部得到确定结果。

### WP6：图层树与 Mixed Inspector

依赖：WP2、WP4、WP5。

交付物：

- 嵌套虚拟图层树；
- 鼠标和键盘排序/跨父级移动；
- 能力驱动 Inspector；
- Mixed/NotApplicable；
- 焦点和屏幕阅读器状态播报。

退出条件：不用鼠标完成创建、选择、嵌套、重命名、排序、属性修改和删除流程。

### WP7：集成、性能与兼容报告

依赖：WP2–WP6。

交付物：

- 复杂嵌套 Fixture；
- Canvas/WebGPU Golden；
- Snapshot/服务恢复测试；
- 60 分钟稳定性记录；
- 常规操作 P95；
- Supported/Partial/Unsupported 兼容矩阵；
- Phase 2 常见节点完成记录。

退出条件：本文第 13 节 Gate 全部通过。

## 12. 验收矩阵

### 12.1 节点闭环

每种节点必须逐项通过：

| 验收项 | Frame | Group | Rectangle | Ellipse | Line/Arrow | Section |
|---|---:|---:|---:|---:|---:|---:|
| 创建/命名 | 必须 | 必须 | 必须 | 必须 | 必须 | 必须 |
| 嵌套/跨父级移动 | 必须 | 必须 | 必须 | 必须 | 必须 | 必须 |
| 保存/刷新 | 必须 | 必须 | 必须 | 必须 | 必须 | 必须 |
| Operation 服务重放 | 必须 | 必须 | 必须 | 必须 | 必须 | 必须 |
| Canvas/WebGPU 渲染 | 必须 | 结构 | 必须 | 必须 | 必须 | 必须 |
| 精确 Hit Test | 必须 | children | 必须 | 必须 | 必须 | 必须 |
| 图层树 | 必须 | 必须 | 必须 | 必须 | 必须 | 必须 |
| Inspector | 必须 | 适用项 | 必须 | 必须 | 必须 | 必须 |
| Duplicate/Delete | 必须 | 必须 | 必须 | 必须 | 必须 | 必须 |
| Undo/Redo | 必须 | 必须 | 必须 | 必须 | 必须 | 必须 |
| Export/兼容报告 | 必须 | 必须 | 必须 | 必须 | 必须 | 必须 |

### 12.2 必测场景

1. 三层旋转 Frame 中包含 Group、Rectangle、Ellipse 和 Arrow；
2. 将多选节点跨父级移动并保持世界视觉位置；
3. 尝试把 Frame 移入自身后代，Transaction 原子拒绝；
4. Group 最后一个 child 被移走时自动解散，Undo 恢复；
5. 删除包含多层 children 的 Frame，Undo 后 ID、顺序和属性完全恢复；
6. Rectangle 四角异值，统一 Radius Inspector 显示 Mixed；
7. Ellipse 在完整圆、Arc 和 Donut 间切换，保存后参数不漂移；
8. Line 在 0°、任意角度和旋转父级中编辑长度；
9. Arrow 起止端点互换，Hit Bounds 覆盖箭头；
10. Center/Inside/Outside Stroke 在画布、Hit Test 和导出中一致；
11. Round/Bevel/Miter Join 与 Miter Limit 退化场景；
12. 奇偶 Dash Pattern、极短线段和极粗 Stroke；
13. 多选不同 Stroke 值后显示 Mixed，并统一覆盖；
14. 保存、Worker 重启、GPU Device Lost、服务恢复后 Document Hash 一致；
15. 未知 Phase 3 Node 仍以 Unknown/Extension Payload 保留，不被改写。

## 13. 阶段 Gate

常见节点子阶段只有同时满足以下条件才可完成：

- Phase 1 Gate 已通过；
- Frame、Group、Rectangle、Ellipse、Line/Arrow 和 Section 全部形成编辑闭环；
- 层级树无环，跨父级 Move 原子且 PositionId 持久；
- 子树删除和 Group 自动解散可精确 Undo/Redo；
- relative/world transform Fixture 无持续漂移；
- `fills[] / strokes[]` 与旧 Snapshot 迁移通过；
- Stroke Align/Cap/Join/Dash/Miter 在渲染、命中和导出中一致；
- Mixed Inspector 和键盘基础流程通过；
- 客户端与服务端重放后 Document Hash 一致；
- 复杂 Fixture 连续编辑 60 分钟无崩溃和明显内存增长；
- 常规操作 P95 输入到画面延迟小于 50 ms；
- 兼容矩阵中的 Supported/Partial/Unsupported 与实际能力一致；
- 无 P0/P1。

任一项未通过，结论均为 `NO-GO`，不能以“基础支持”代替完成记录。

## 14. 风险与控制措施

### 14.1 Phase 1 契约被反向修改

风险：为了快速加入节点，直接修改已发布字段或改变旧 Hash 语义。

控制：Protobuf append-only；新 Snapshot 单向迁移；旧 Fixture 永久保留；Schema ADR 先于实现合并。

### 14.2 Group 被错误实现为 Frame

风险：Group 拥有独立固定 Bounds、允许空 children 或继承 Clip/Auto Layout。

控制：Group 使用专属不变量和复合 Command；派生 Bounds；禁止空 Group。

### 14.3 Arrow 被建成独立节点

风险：Phase 3 映射需要额外降级，Stroke 编辑出现两套逻辑。

控制：Arrow 仅存在于 ToolKind；Canonical 一律保存为 Line + StrokeCap。

### 14.4 Stroke 多实现漂移

风险：Canvas、WebGPU、Hit Test 和导出分别计算描边，结果不一致。

控制：Rust Stroke 几何单一来源；各消费端共享 Tessellation/Outline/Bounds 结果和 Fixture。

### 14.5 嵌套 Transform 漂移

风险：跨父级移动反复分解矩阵导致坐标积累误差。

控制：Canonical 保存 relative transform；操作使用 f64；明确矩阵规范化；Golden 使用误差预算和重复操作测试。

### 14.6 History 和 Snapshot 体积增长

风险：子树删除、Paint 数组和 Vector 几何使 Undo 与持久化超预算。

控制：提交前估算；Page Chunk；结构化差异；有界 History；超限原子拒绝并返回结构化错误。

### 14.7 Phase 2 范围失控

风险：常见节点工作与 Vector、Boolean、Effect、Auto Layout 同时展开，无法形成稳定闭环。

控制：严格按 WP0–WP7 依赖推进；WP4/WP5 完成前不把高级图形标记为 Supported。

## 15. 建议的代码影响范围

实施时预计至少涉及：

- `crates/editor-core`：Node 能力、Command、Reducer、不变量、History、Hash；
- `schemas/proto/editor/v1/editor.proto`：Node/Operation append-only 扩展；
- `crates/document-codec`：Snapshot 迁移和 Fixture；
- `crates/document-service`：Operation/Snapshot Adapter；
- `crates/editor-wasm`：新节点和属性桥接；
- `crates/renderer-wgpu`：层级 Scene、Stroke 和端点装饰；
- `src/lib/editor-protocol.ts`：Web/Worker 投影类型；
- `src/workers/editor.worker.ts`：层级投影、渲染、命中和工具解析；
- `src/components/editor`：图层树、工具栏、Inspector 和键盘流程；
- `packages/protocol-types`：生成协议类型；
- `fixtures/documents`：迁移、结构和复杂场景 Fixture；
- `verification/phase2`：Golden、性能、稳定性和人工验收记录；
- `docs/compatibility-matrix.md`：能力等级和已知降级项。

每个工作包应尽量纵向完成一个可验收闭环，避免长期保留“Schema 已支持但 UI/渲染未支持”的中间状态。

## 16. 评审决策清单

进入实现前需要明确记录以下决策：

- [ ] Phase 1 Gate 是否已经 PASS；
- [ ] Group 折叠状态属于 Document 还是用户 View State；
- [ ] Line 是否允许零长度；
- [ ] 透明旧 Paint 迁移为空数组还是透明 Paint；
- [ ] Transform 是否在本阶段直接升级为 2×3 Canonical 矩阵；
- [ ] Per-side Stroke 第一版是否仅支持 Frame/Rectangle；
- [ ] Group 最后一个 child 移除时是自动解散还是拒绝；
- [ ] Section 是否纳入常见节点首个里程碑；
- [ ] Stroke Tessellation 由哪个 Rust crate 持有；
- [ ] Canvas/WebGPU/SVG/PDF 如何共享 Stroke 几何；
- [ ] Snapshot 新版本号和最低 Engine Semantics Version；
- [ ] Phase 2 常见节点完成记录的验收人与签署方式。

推荐默认决策：

- Group 折叠状态进入用户 View State；
- 第一版拒绝零长度 Line；
- 透明旧 Paint 保留为透明 Paint；
- Phase 2 直接采用 2×3 relative transform；
- Per-side Stroke 第一版只开放给 Frame/Rectangle；
- 空 Group 自动解散；
- Section 纳入 WP4；
- Stroke 几何由 Rust 几何层持有并服务所有渲染、命中和导出消费者。
