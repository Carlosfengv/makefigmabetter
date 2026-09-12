# 36 种图层与 Figma Plugin API Node 的对齐复核

日期：2026-08-24
范围：本项目现有、且能够一对一对应 Figma Plugin API `SceneNode` 的 33 种 Canonical 图层。依据为 [Figma Plugin API Nodes](https://developers.figma.com/docs/plugins/api/nodes/)、[ComponentNode](https://developers.figma.com/docs/plugins/api/ComponentNode/)、[ComponentSetNode](https://developers.figma.com/docs/plugins/api/ComponentSetNode/)、[ConnectorNode](https://developers.figma.com/docs/plugins/api/ConnectorNode/)、[EmbedNode](https://developers.figma.com/docs/plugins/api/EmbedNode/)、[EmbedData](https://developers.figma.com/docs/plugins/api/EmbedData/)、[HighlightNode](https://developers.figma.com/docs/plugins/api/HighlightNode/)、[HandleMirroring](https://developers.figma.com/docs/plugins/api/HandleMirroring/)、[InteractiveSlideElementNode](https://developers.figma.com/docs/plugins/api/InteractiveSlideElementNode/)、[LinkUnfurlNode](https://developers.figma.com/docs/plugins/api/LinkUnfurlNode/)、[LinkUnfurlData](https://developers.figma.com/docs/plugins/api/LinkUnfurlData/)、[InstanceNode](https://developers.figma.com/docs/plugins/api/InstanceNode/)、[SlotNode](https://developers.figma.com/docs/plugins/api/SlotNode/)、[SlideGridNode](https://developers.figma.com/docs/plugins/api/SlideGridNode/)、[SlideNode](https://developers.figma.com/docs/plugins/api/SlideNode/)、[SlideRowNode](https://developers.figma.com/docs/plugins/api/SlideRowNode/)、[SlideTransition](https://developers.figma.com/docs/plugins/api/SlideTransition/)、[StampNode](https://developers.figma.com/docs/plugins/api/StampNode/)、[StickyNode](https://developers.figma.com/docs/plugins/api/StickyNode/)、[TableNode](https://developers.figma.com/docs/plugins/api/TableNode/)、[TableCellNode](https://developers.figma.com/docs/plugins/api/TableCellNode/)、[TextPathNode](https://developers.figma.com/docs/plugins/api/TextPathNode/)、[ArcData](https://developers.figma.com/docs/plugins/api/ArcData/) 与 [relativeTransform](https://developers.figma.com/docs/plugins/api/properties/nodes-relativetransform/)。
范围更正：当前对齐范围为 36 种 Canonical `SceneNode`，包含后续补齐的 `TEXT_PATH`、`TRANSFORM_GROUP`、`WASHI_TAPE` 与 `WIDGET`。

## 结论

- 36 个类型名、空间变换、Ellipse Arc、核心可写属性现在有一条显式的 Figma Adapter 边界，不再靠 REST 导入器或 UI 字段的偶然同名来兼容。
- 这不是完整的 Figma Plugin Runtime：没有全局 `figma` 对象、实时 Node 对象身份、完整容器方法或异步导出。适配器将可无损承载的调用转换成 Canonical Transaction；不能等价实现的项必须返回拒绝原因或保留在兼容扩展中。
- 当前 `image` 是本地扩展节点，不属于 Figma Plugin API 的 `SceneNode` 类型。Figma 的普通图片由 image paint 表达，因此不计入本次 36 种对齐范围。

## 已落地的共同契约

| Figma Plugin API 概念 | Canonical 对齐方式 | 状态 |
| --- | --- | --- |
| `type` | 36 个 Canonical `NodeKind` 映射为官方大写 `SceneNode.type` | 已对齐 |
| `relativeTransform` / `absoluteTransform` | Canonical `{a,b,c,d,e,f}` ↔ Figma `[[a,c,e],[b,d,f]]`；Group/Boolean child 按最近 Frame/Page 容器投影 | 已对齐 |
| `x`、`y`、`width`、`height` | 作为 Figma 的只读空间观察值投影；尺寸修改由 `resize` / `resizeWithoutConstraints` 生成事务 | 已对齐 |
| `name`、`visible`、`locked`、`opacity`、`rotation` | 写入适配为 `update` Transaction | 已对齐 |
| `blendMode` | `NORMAL/MULTIPLY/SCREEN/OVERLAY/DARKEN/LIGHTEN` 无损映射；其他 Figma 模式明确拒绝 | 部分 |
| `constraints` | `MIN/CENTER/MAX/STRETCH/SCALE` 映射 | 已对齐（不含 Group/Boolean） |
| `isMask` | Alpha mask 映射为专门的 `setMask` Transaction | 部分：仅 Alpha |
| `remove()` | 映射为 `delete` Transaction | 已对齐 |
| `getPluginData` / `setPluginData` | 显式 pluginId 命名空间存入 Canonical `extensions`；空字符串删除键 | 已对齐（不含 shared/relaunch data） |
| `exportAsync` / per-node `exportSettings` | 导入值保留在 extension；没有执行型 Plugin API 方法 | 未对齐 |

相关实现：

- `src/lib/figma-plugin-node-projection.ts`：只读节点投影和坐标/Arc 换算。
- `src/lib/figma-plugin-node-mutation.ts`：受限写入 API 到 `EditorCommand` 的映射。
- `src/lib/figma-rest-import.ts`：复用 Plugin 边界解析 Arc，避免将合法 `innerRadius: 0` 丢弃。

## 逐节点复核

| Figma 类型 | Canonical 类型 | 已对齐的专有参数/API | 仍需补齐 | 结论 |
| --- | --- | --- | --- | --- |
| `FRAME` | `frame` | `clipsContent`、圆角/逐角半径/平滑度、constraints、Auto Layout Canonical 子集 | `children`/插入/查询容器 API，完整 Grid Auto Layout、layout grids、prototype/transition、完整 export | 部分 |
| `GROUP` | `group` | 类型、容器相对 Transform 投影、删除与共同属性 | `children`、`appendChild`、`insertChild`、`find*` 等活对象容器 API；完整节点复制/查询 API | 部分 |
| `SECTION` | `section` | `sectionContentsHidden`、圆角参数、共同属性 | 容器方法、完整布局/导出 API | 部分 |
| `RECTANGLE` | `rectangle` | 圆角/逐角半径/平滑度、共同属性、现有 Canonical stroke/paint/effect 数据 | Figma 完整 Paint、Effect、样式绑定和开发模式字段的对象级 API | 部分 |
| `ELLIPSE` | `ellipse` | `arcData` 使用弧度边界；`innerRadius` 的 `0` 与 `1` 合法 | 完整 Geometry/Paint 对象 API | 部分 |
| `POLYGON` | `polygon` | `pointCount`，范围为可编辑的 3–100 | Figma 更大参数范围、完整 Geometry/Paint 对象 API | 部分 |
| `STAR` | `star` | `pointCount`、`innerRadius` | 当前安全范围为 `0.05–0.95`，不能表示接近退化的 Figma Star；完整 Geometry/Paint 对象 API | 部分 |
| `VECTOR` | `vector` | 现有可编辑 `vectorPath`、点/柄事务、共同属性 | Figma `vectorNetwork` / `vectorPaths` 兼容投影及全套 Geometry API | 部分 |
| `BOOLEAN_OPERATION` | `booleanOperation` | `booleanOperation`（四种 selector）、共同属性 | children 容器方法、Boolean 的完整派生几何与插件运行时行为 | 部分 |
| `SLICE` | `slice` | 类型、空间观察值、删除/resize | Figma `exportAsync` 和可执行 per-node export presets | 部分 |
| `LINE` | `line` | 类型、空间观察值、现有 Canonical line cap/join/dash | Plugin `strokeCap` 复合对象投影、完整 Geometry/Paint 对象 API | 部分 |
| `TEXT` | `text` | `characters`、共同属性；Canonical 已有 UTF-8 Style Run 与字体引用 | `getRange*`/`setRange*`、`loadFontAsync`、字体样式/段落的完整 Plugin API 语义 | 部分 |
| `CODE_BLOCK` | `codeBlock` | `code`、开放的 `codeLanguage`、专用持久化类型与 Canvas 代码渲染 | 完整语言枚举与完整 FigJam 编辑体验 | 部分 |
| `COMPONENT` | `component` | Frame 容器契约、`description`、`descriptionMarkdown`、`documentationLinks`、`key`/`remote`、component property 定义的增删改、`createInstance`/实例查询、`createSlot` | 活对象/异步 Runtime 外观不在本 Adapter 范围 | 部分 |
| `INSTANCE` | `instance` | `mainComponent` 链接、`scaleFactor`、`componentProperties`、`overrides`、暴露状态、创建/交换/属性设置/移除覆盖/分离；组件改动在同一事务同步到未覆盖的克隆层 | 嵌套实例的完整 Figma override-preservation 启发式与 VariableAlias | 部分 |
| `SLOT` | `slot` | `type`、Frame-like 容器与裁剪、属性标识；`ComponentNode.createSlot` 原子创建 Slot 与对应 `SLOT` property | `resetSlot` 的完整 preferred/min/max 限制与实例内容恢复 | 部分 |
| `COMPONENT_SET` | `componentSet` | Frame-like 容器、专用类型、`key`/`remote`/描述/文档链接、`variantGroupProperties`、按左上子 Component 推导的 `defaultVariant`；Core 限制直接子节点只能是 Component | 官方“移走最后一个 Component 自动删除集合”语义、完整 variant property 对象与活对象容器 API | 部分 |
| `CONNECTOR` | `connector` | 专用类型、零高线几何、`connectorLineType`、`connectorStart`/`connectorEnd`、两端 cap、`reconnect()` 的 Transaction 适配，以及 Canvas 直线回退渲染；标签和圆角按文档保持只读投影 | Elbowed/Curved 的真实布线和磁吸求解、完整 FigJam 标签/文本背景渲染、官方 cap 联合类型 | 部分 |
| `EMBED` | `embed` | 专用类型、只读 `embedData`（`srcUrl`、canonical URL、标题、提供方）、`createLinkPreviewAsync` 的受校验创建适配、持久化与普通矩形预览回退 | 远端 provider 发现与 iframe 激活、真实预览截图、`clone()` 的活对象 API | 部分 |
| `HIGHLIGHT` | `highlight` | 专用类型、稳定 Canonical 路径作为 `vectorPaths` 投影、路径更新适配、`handleMirroring` 的 `NONE/ANGLE/ANGLE_AND_LENGTH` 枚举及持久化 | 完整 Figma `VectorNetwork` 拓扑转换、动态页面的异步网络 API、与目标节点的 stickable 吸附行为 | 部分 |
| `INTERACTIVE_SLIDE_ELEMENT` | `interactiveSlideElement` | 专用类型、只读 `interactiveSlideElementType`（`POLL/EMBED/FACEPILE/ALIGNMENT/YOUTUBE`），空间/可见性通用事务与持久化 | 文档规定插件不能创建或改写互动数据；也未实现 Slides 的真实交互、`clone()` 活对象 API | 部分 |
| `LINK_UNFURL` | `linkUnfurl` | 专用类型、只读 `linkUnfurlData`（URL、标题、描述、提供方）、`createLinkPreviewAsync` 的受校验创建适配及持久化 | 远端富预览抓取、真实缩略图与 `clone()` 活对象 API | 部分 |
| `MEDIA` | `media` | 专用类型、只读 `mediaData.hash`、`createGif` 的资源 ID + hash 创建适配、标准 resize 事务与媒体渲染回退 | GIF 解码/播放、时间轴控制、`clone()` 活对象 API | 部分 |
| `SHAPE_WITH_TEXT` | `shapeWithText` | 专用类型、30 个官方 `shapeType` 枚举、只读文本子层投影、圆角投影、`createShapeWithText`/缩放与形状切换适配 | 各形状的精确路径渲染、TextSublayer 的完整对象 API、`rescale()` 的样式比例变化 | 部分 |
| `SLIDE_GRID` | `slideGrid` | 专用类型、只读 Plugin API 投影；创建工具与直接写入适配均拒绝；Core 强制每页唯一、顶层、仅 `SLIDE_ROW` 子节点 | 没有 `clone()` 抛错语义 | 部分 |
| `SLIDE` | `slide` | 专用类型、固定 `1920×1080` 且不可旋转/缩放的 Core/适配器约束、`isSkippedSlide`、完整 `SlideTransition`（23 个 style、8 个 curve、ON_CLICK/AFTER_DELAY timing）读写与持久化、受 SlideRow 校验的 `createSlide` | 未实现 clone 与演示播放 | 部分 |
| `SLIDE_ROW` | `slideRow` | 专用类型、只读投影和直接写入拒绝、`createSlideRow` 适配；Core 强制每页唯一顶层 `SLIDE_GRID`，其子节点只可为 SlideRow，SlideRow 子节点只可为固定尺寸 Slide | `clone()` 活对象 API | 部分 |
| `STAMP` | `stamp` | 专用类型；官方的 8 种印章类别（`+1`、Dot、Heart、Profile、Question、Star、Thumbs down、Thumbs up）直接由 `name` 无损保留 | Stamp Wheel 创建、`getAuthorAsync()` 与 fileusers 权限/联网语义、精确印章插画 | 部分 |
| `STICKY` | `sticky` | 专用类型、`TextSublayer` 内容、`authorVisible`、`authorName`、`isWideWidth`、受认证作者名参数校验的 `createSticky` 及持久化 | 实时用户身份/权限服务、完整 TextSublayer 对象与 clone | 部分 |
| `TABLE` / `TABLE_CELL` | `table` / `tableCell` | 专用类型、二维 cell 子树、`numRows`/`numColumns`、`cellAt`、单元格 text 与 row/column index、`createTable`、行列插入/删除/移动/尺寸调整 | 合并单元格、自动内容布局、完整 fill/style 对象与 clone | 部分 |
| `TEXT_PATH`（Beta） | `textPath` | 专用类型、`characters`、稳定 `vectorPath` → 只读 `vectorPaths`、`textPathStartData.{segment,position}`、水平/垂直对齐、`autoRename`、`createTextPath` 的 Vector→TextPath 原子替换适配、持久化和事务边界 | `createTextPath` 对 Rectangle/Ellipse/Polygon/Star/Line 的路径提取、原 ID 保持、`vectorNetwork`/`handleMirroring` 的完整 Figma 网络表示、真实曲线排版、字体加载门禁、`hasMissingFont` 的资源解析、全部文本范围 API 与 `clone()` | 部分 |
| `TRANSFORM_GROUP`（Beta） | `transformGroup` | 专用容器类型、`transformModifiers` 的 `REPEAT`/`LINEAR`/`RADIAL` 字段校验与持久化、只读投影、按共同父级包装非空节点集合的 `transformGroup` 事务；SVG/PNG 可物化最多 64 个线性 Repeat，Canvas 对安全 leaf subtree 使用同一 group-local affine | 径向/叠加 modifier、Canvas 的 mask/clip/effect/嵌套容器 subtree、任意目标 parent/index、实例子节点等不可重父化规则、`clone()` | 部分 |
| `WASHI_TAPE` | `washiTape` | 专用类型、共同 SceneNode 属性与 Figma Adapter 投影、持久化/渲染回退 | FigJam 贴附（stickable）关系、原生胶带纹理与 `clone()` | 部分 |
| `WIDGET` | `widget` | 专用类型、只读 `widgetId`、同 Widget 身份下可读的 `widgetSyncedState`、持久化，以及带 manifest ID 校验的 `setWidgetSyncedState` 事务适配 | 真实 Widget manifest/runtime、`cloneWidget`、同步 map 的协作合并、stickable 与完整动画/变量 API | 部分 |

## 必须保持明确的差距

1. **对象模型而非数据模型。** 当前 Adapter 是纯数据投影 + Transaction builder。真正的 Plugin API 还需要带生命周期的 `BaseNode`/`SceneNode` 对象、父子树方法、搜索与 clone 语义；这些不能由一个 `CanvasNode` JSON 直接替代。
2. **类型范围。** 官方 Nodes 列出的 SceneNode 类型均已拥有显式 `NodeKind`；未实现 API 仍逐项记录在上表，不能通过伪造行为宣称等价。
3. **Paint、Effect、Blend。** 内核具备一部分颜色、线性渐变、stroke、effect 和六种 blend 的 Canonical 结构，但尚未形成完整 Figma `Paint` / `Effect` 联合类型和所有枚举的节点 API。缺少的值应拒绝或保留 source extension，不能悄悄改成 `NORMAL`。
4. **文本与矢量。** UTF-8 Style Run 与稳定路径点是编辑内核所需的内部表达；它们与 Figma range API、`VectorNetwork`/SVG path 的逐字段兼容需要单独的双向 Adapter，不能把任一方直接当作事实来源。
5. **导出。** 当前有编辑器级 SVG/PNG/PDF 冻结导出，不能等同于 `node.exportAsync(settings)`。要支持它，需要先引入经过预算校验的 Canonical per-node export preset，再提供异步方法。

## 后续优先级

1. 为 Frame、Group、Section、Boolean 建立受限容器 API（children 只读投影、append/insert/reparent、findChildren），所有结构修改仍经原子 Transaction。
2. 扩展几何投影：统一映射 stroke cap/join/dash、paint stack、effect stack；对未覆盖的 Figma 枚举返回结构化“不支持”。
3. 为 Text 实现 font-load gate 与 UTF-16 Plugin Range ↔ Canonical UTF-8 byte range 转换，再提供最常用 `getRange*`/`setRange*`。
4. 设计 per-node export preset 的 Core 字段与预算策略后再实现 `exportAsync`；不要从 REST extension 直接执行。
5. 单独制定 VectorNetwork/`vectorPaths` 的损失模型与兼容性报告，避免破坏现有稳定 PointId 编辑语义。
