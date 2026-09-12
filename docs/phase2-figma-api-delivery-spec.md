# Phase 2：Figma API 对齐与真实交付实施规格

- 状态：实施规格
- 日期：2026-08-16
- 适用范围：Phase 2 编辑器内核、渲染、布局、导出与兼容性报告
- 关联文档：[Phase 2 剩余实施计划](./phase2-remaining-implementation-plan.md)

## 1. 目标与边界

Phase 2 的目标不是完整复刻 Figma 产品或 `.fig` 私有格式，而是交付一个可编辑、可保存、可重放、可渲染、可导出的 Figma 核心语义子集。

本项目的 Rust Canonical Document 是唯一写入事实来源。Figma REST JSON、Plugin API 节点和导出设置均是外部兼容契约：它们指导导入、导出和字段命名，但不得绕过 Canonical Transaction 直接修改 UI 状态。

Figma REST API 以文件 JSON、节点几何和渲染文件为主；Plugin API 则暴露可编辑的节点和属性 mixin。因此，本项目应采用“内部 Canonical 模型 + Figma Adapter”的结构，而不是把 REST 响应直接当作编辑模型。

官方参考：

- [Figma REST Node types](https://developers.figma.com/docs/rest-api/file-node-types/)
- [Figma REST property types](https://developers.figma.com/docs/rest-api/file-property-types/)
- [Figma Plugin API node model](https://developers.figma.com/docs/plugins/api/nodes/)
- [Figma Plugin API export settings](https://developers.figma.com/docs/plugins/api/ExportSettings/)

### 1.1 Phase 2 必须交付

1. 页面与有序层级树：Page、Frame、Group、Section、普通 Scene Node。
2. 可编辑几何：基础图形、VectorPath、Boolean、Stroke/Outline、变换、Bounds 与 Hit Test。
3. 外观：Paint Stack、渐变、Stroke、Opacity、首批 Blend Mode、Effect Stack。
4. 组织操作：多选 Align、Distribute、确定性 Tidy up、Reparent、排序、Group/Ungroup、Slice。
5. 裁剪与导出：Frame Clip、Alpha Mask、SVG/PNG/PDF、字体/图片资源策略、兼容性报告。
6. 文本与布局：Style Run、富文本剪贴板、Constraints、横/纵向 Auto Layout、Hug/Fill/Fixed、Wrap、Absolute。

### 1.2 明确不属于 Phase 2

以下能力必须以扩展字段保留或明确拒绝，不得为了兼容导入而伪造支持：

- Component、Instance、Variant、Styles、Variables、Library；
- Figma `GRID` Auto Layout 与 Grid cell/span 语义；
- 完整 VectorNetwork 无损编辑；
- Progressive Blur、Noise、Texture、Glass、Shader 等扩展 Effect；
- 原生可编辑矢量 PDF；
- Figma REST 双向写回、多人协作、评论、Presence；
- `.fig` 私有格式读写。

## 2. 设计原则

1. **Canonical-first**：所有编辑从具名 Command 进入 Rust Core，派生渲染数据不得回写 Document。
2. **单一几何来源**：Canvas、Hit Test、SVG、PNG、PDF 必须消费同一冻结几何投影。
3. **冻结导出**：导出开始时捕获不可变 `revision`；异步下载资源或 WASM 派生不得改写该输入。
4. **显式降级**：不支持、资源不可用、预算超限、无法等价导出的能力必须进入 machine-readable sidecar。
5. **可重放**：任何用户操作都应是一笔原子 Transaction，可 Undo/Redo、可服务重放、可 Hash 验证。
6. **受限资源**：路径点、图片、字体、导出表面、Effect 离屏面、递归深度必须有硬上限。
7. **协议只追加**：Protobuf 字段、Snapshot 版本和 `extensions` 的演进保持 append-only。

## 3. Canonical 数据模型

### 3.1 文档根

```ts
type Document = {
  schemaVersion: number
  documentId: string
  revision: number
  documentHash: string
  pages: PageRecord[]
  nodes: Record<NodeId, NodeRecord>
  assets: Record<AssetId, AssetRecord>
  exportPolicy: ExportPolicy
}

type PageRecord = {
  id: PageId
  name: string
  positionId: PositionId
}
```

`revision` 和 `documentHash` 是导出、远端重放和恢复验证的依据；Page 的 `positionId` 是多页 PDF、图层顺序和稳定排序的唯一依据，禁止使用数组下标作为事实来源。

### 3.2 通用节点

```ts
type NodeRecord = {
  id: NodeId
  figmaNodeId?: string
  kind: NodeKind
  pageId: PageId
  parentId?: NodeId
  positionId: PositionId
  name: string

  visible: boolean
  locked: boolean
  opacity: number
  blendMode: BlendMode
  relativeTransform: Affine2D
  size: { width: number; height: number }

  appearance: Appearance
  geometry?: Geometry
  text?: TextContent
  constraints?: Constraints
  autoLayout?: AutoLayout | ChildLayout
  mask?: MaskRole
  exportSettings?: ExportSetting[]
  extensions?: Record<string, unknown>
}
```

`figmaNodeId` 只用于导入/回溯外部来源；本地 `id` 和 `positionId` 仍是 Canonical 事实。导入的未知或暂不支持字段必须放入受限 `extensions`，并在再次导出/兼容报告时保持可见，不能静默遗失。

### 3.3 几何

```ts
type Geometry =
  | { type: "parametric"; shape: "rectangle" | "ellipse" | "polygon" | "star" | "line"; params: ShapeParams }
  | { type: "vectorPath"; fillRule: "nonZero" | "evenOdd"; subpaths: Subpath[] }
  | { type: "boolean"; operation: "union" | "intersect" | "subtract" | "exclude" }

type Subpath = {
  closed: boolean
  points: Array<{
    id: PointId
    position: Vec2
    handleIn?: Vec2
    handleOut?: Vec2
    pointType: "corner" | "mirrored" | "asymmetric"
  }>
}
```

Figma REST 的 `Path { path, windingRule }`、`fillGeometry` 和 `strokeGeometry` 是导入/验证投影。内部仍保存稳定 PointId 与控制柄，使 Pen、Split、Connect、Flatten、Undo/Redo 可编辑；不应把 Figma 返回的扁平 SVG path 当作唯一编辑格式。

Figma 的 `relativeTransform` 是 2×3 仿射矩阵；尺寸变更应由 Width/Height 及布局/约束驱动，而非把缩放长期编码进矩阵。 [Figma Transform property](https://developers.figma.com/docs/plugins/api/properties/nodes-relativetransform/)

### 3.4 Appearance、Effect 与 Mask

```ts
type Appearance = {
  fills: Paint[]
  strokes: Paint[]
  stroke: StrokeStyle
  effects: Effect[]
}

type Effect =
  | { type: "dropShadow"; offset: Vec2; blur: number; spread: number; color: Color; visible: boolean }
  | { type: "innerShadow"; offset: Vec2; blur: number; spread: number; color: Color; visible: boolean }
  | { type: "layerBlur"; radius: number; visible: boolean }
  | { type: "backgroundBlur"; radius: number; visible: boolean }

type MaskRole =
  | { enabled: false }
  | { enabled: true; type: "alpha" }
```

Figma 可表达 `ALPHA`、`VECTOR`、`LUMINANCE` 三类 mask；Phase 2 只完整支持 `alpha`。导入 `VECTOR`/`LUMINANCE` 时必须保留来源字段并写入兼容性报告，不能错误转成 alpha。Figma Effect 还包含 Noise、Texture 等类型；Phase 2 仅持久化上述四类。 [Figma Node mask fields](https://developers.figma.com/docs/rest-api/file-node-types/), [Figma Effect types](https://developers.figma.com/docs/rest-api/file-property-types/)

### 3.5 文本与字体资源

```ts
type TextContent = {
  characters: string
  runs: Array<{
    startUtf8: number
    endUtf8: number
    font?: FontRef
    fontSize: number
    fontWeight: number
    italic: boolean
    letterSpacing: number
    color?: Color
  }>
  paragraph: {
    alignment: "left" | "center" | "right" | "justify"
    lineHeight?: number
    paragraphSpacing: number
  }
  autoSize: "fixed" | "height" | "widthAndHeight"
  fallbackFonts: FontRef[]
}

type FontRef = {
  assetId: AssetId
  faceIndex: number
  variationAxes?: Array<{ tag: string; value: number }>
}
```

文本 range 统一使用 UTF-8 byte offset，输入层负责将 DOM UTF-16 selection 安全转换。Font bytes 永不放进 Node；它们由 Asset Service 授权并以 `assetId` 引用。

### 3.6 Constraints 与 Auto Layout

```ts
type Constraints = {
  horizontal: "min" | "center" | "max" | "stretch" | "scale"
  vertical: "min" | "center" | "max" | "stretch" | "scale"
}

type AutoLayout = {
  mode: "none" | "horizontal" | "vertical"
  wrap: boolean
  padding: [top: number, right: number, bottom: number, left: number]
  itemSpacing: number
  // Figma counterAxisSpacing; omitted preserves the legacy itemSpacing value.
  trackSpacing?: number
  // Figma counterAxisAlignContent; only valid when wrap is true.
  trackAlignment?: "auto" | "spaceBetween"
  // 对应 Figma MIN/CENTER/MAX/SPACE_BETWEEN；baseline 在此无效。
  primaryAlignment: "start" | "center" | "end" | "spaceBetween"
  // 对应 Figma counterAxisAlignItems；baseline 仅能用于 horizontal Frame。
  counterAlignment: "start" | "center" | "end" | "baseline"
  primarySizing: "fixed" | "hug"
  counterSizing: "fixed" | "hug"
}

type ChildLayout = {
  positioning: "auto" | "absolute"
  horizontal: "fixed" | "hug" | "fill"
  vertical: "fixed" | "hug" | "fill"
  // 缺省为 inherit；内部以 start/end 对应 Figma 的 MIN/MAX。
  alignSelf?: "start" | "center" | "end"
  minWidth?: number
  maxWidth?: number
  minHeight?: number
  maxHeight?: number
}
```

Figma 的 `FILL` 只适用于 Auto Layout 直接 child，`HUG` 只适用于 Auto Layout frame 与 Text；项目必须在 Core 验证这些适用范围。`counterAxisAlignItems: "BASELINE"` 仅适用于水平 Auto Layout Frame，沿子项文本基线对齐；它不能作为 primary axis 或子项 `layoutAlign`/`alignSelf` 的值。Canonical 的确定性规则为：Text 的 baseline 先将第一行的 nominal font box 居中到固定/显式 line-height，再取 nominal font size 的 80%（与 Canvas 的无字体度量 fallback 相同）；非 Text 使用自身下边缘；每个 wrap track 独立取继承父对齐的最大 baseline，显式 `alignSelf` 仍覆盖该规则。Figma 也已包含 `GRID`，但本项目在 Phase 2 仅实现 HORIZONTAL/VERTICAL；导入 GRID 时保留扩展并降级为非布局 Frame 或只读预览。 [Figma layout sizing](https://developers.figma.com/docs/plugins/api/properties/nodes-layoutsizingvertical/), [Figma layout positioning](https://developers.figma.com/docs/plugins/api/properties/nodes-layoutpositioning/), [Figma counterAxisAlignItems](https://developers.figma.com/docs/plugins/api/properties/nodes-counteraxisalignitems/), [Figma counterAxisAlignContent](https://developers.figma.com/docs/plugins/api/properties/nodes-counteraxisaligncontent/)

`spaceBetween` 只允许作为 `primaryAlignment`；出现在 `counterAlignment`、`alignSelf` 或 `primaryAlignment: baseline` 的任何 Protobuf/Snapshot/WASM 输入均为无效输入，必须原子拒绝，不能悄悄降级成 `start`。

## 4. Figma 字段映射

| Figma 概念 | Canonical 映射 | Phase 2 预期 |
| --- | --- | --- |
| `id` | `figmaNodeId` + 本地 `NodeId` | 导入可追溯；本地 ID 不复用 |
| `children` | `parentId` + `positionId` | 稳定树与稳定排序 |
| `relativeTransform` / `size` | `relativeTransform` + `size` | 完整支持 |
| `fills` / `strokes` | `Appearance` paint stack + `assetRequests` | 基础 Paint、渐变；图片须经授权后绑定 |
| `imageRef` / `GET /v1/files/:key/images` | `FigmaRestAssetRequest` → `DocumentAsset.assetId` | 短期 URL 不入文档；Asset Service 准入后才原子绑定 |
| `strokeWeight` / `strokeCap` / `strokeJoin` / `strokeDashes` | `StrokeStyle` | Basic Stroke 的宽度、端点、连接与 dash；未知 cap 不近似 |
| `individualStrokeWeights` / `strokeAlign` | `StrokeStyle` | 仅 Core 允许的 Frame/Rectangle 边宽与合法形状对齐 |
| `cornerRadius` / `rectangleCornerRadii` / `cornerSmoothing` | 参数图形圆角 | Frame/Rectangle/Section 的可编辑圆角子集 |
| `arcData` | Ellipse 参数图形弧 | 角度归一到 Canonical 度数；仅有效 donut/arc |
| `fillGeometry` / `strokeGeometry` | `Geometry` 的派生投影 | 导入、导出、验证；不替换可编辑 Path |
| `BOOLEAN_OPERATION` | `Geometry.boolean` + 活 children | Union/Intersect/Subtract/Exclude |
| `isMask` / `maskType` | `MaskRole` | Alpha 完整；其余保留+报告 |
| `effects` | 有序 `Effect[]` | 四类核心 Effect；未知类型扩展保留 |
| `constraints` | `Constraints` | 普通 Frame child 完整支持 |
| `layoutMode` / `layoutSizing*` | `AutoLayout` / `ChildLayout` | 横/纵向支持；GRID 延后 |
| `layoutPositioning` | `ChildLayout.positioning` | AUTO/ABSOLUTE 支持 |
| `exportSettings` | `figma.rest.export-settings.v1` extension（当前） | 可追溯保留；执行型 per-node preset 待 Core 契约 |
| `SLICE` | 非绘制 `Slice` Node | 旋转世界区域导出 |

## 5. 功能工作包与交付目标

### R4：Align、Distribute 与基础 Tidy up（部分完成）

这是 Phase 2 必须新增的组织编辑工作包。

```ts
type ArrangeCommand =
  | { type: "align"; ids: NodeId[]; axis: "x" | "y"; mode: "min" | "center" | "max"; reference: "selectionBounds" | "primaryNode" }
  | { type: "distribute"; ids: NodeId[]; axis: "x" | "y"; mode: "edgeGap" | "centerGap" }
  | { type: "tidyUp"; ids: NodeId[]; axis: "auto" | "x" | "y"; gap: number; anchor: "first" | "selectionBounds" }
```

规则：

1. 普通图层按 world render bounds 计算，再转换回各自 parent-local matrix。
2. 旋转图层默认按 render bounds 对齐；“按未旋转几何框”只能作为明确的后续选项。
3. Auto Layout 的 flow child 不允许直接写 x/y；应更新 `alignSelf`、container alignment、Gap 或 PositionId。
4. Auto Layout 的 absolute child 可以参与世界坐标对齐。
5. Tidy up 仅执行确定性等距排列，不做“猜测网格”或隐式创建 Auto Layout。
6. 每次操作是一笔 Transaction；任何不可布局节点、锁定节点或不适用目标必须原子拒绝或明确跳过并报告。

验收：普通、旋转、嵌套 Group、Frame Clip、Auto Layout/Absolute、Undo/Redo、服务重放、100+ node 选区均有固定回归。

当前落地（2026-08-16）：`EditorCommand.arrange` 已在 Engine Worker 以世界渲染边界解析成具体 `update` 批次，再作为一笔 Rust/WASM Transaction 进入 Undo、remote operation 和重放链路。命令与图层面板都支持 selection bounds 或首个选择根节点的 `primaryNode` 参考框；UI 提供六种对齐、双轴 edge-gap/center-gap 分布，以及可输入 gap 的横向、纵向和按 selection render bounds 主方向的 `auto` Tidy up。旋转、相对变换和 Group 的 legacy 子项沿用同一世界平移投影规则。对于同一 active Auto Layout Frame 的多个 flow child，**仅交叉轴**对齐会原子映射为各 child 的 `alignSelf`（min/center/max → start/center/end），不再直接写入坐标；absolute child 仍可参与世界坐标对齐。主轴对齐、分布和 Tidy up 没有不改变 PositionId 或 container gap 的等价写法，因此与跨页面、锁定、混合父容器一样原子拒绝。101 图层的 Tidy up 固定回归已验证前/反向 selection 得到相同 concrete update 集合。`alignSelf` 现由协议编码器为 **child node** 输出 `setAutoLayout` 操作，避免只有本地 Core 生效而服务端静默丢弃子项语义。真实浏览器以既有远端文档验证横向 Frame 内两个 flow child 的“顶部对齐”：r84→r85，hash 为 `2b0b89067d3e`；随后“底部对齐”r86（`5fb6d797f006`）→ Undo r87（恢复 `2b0b89067d3e`）→ Redo r88（恢复 `5fb6d797f006`），重载后仍显示 `remote document loaded`、r88 与同一 hash。因此 Arrange 的浏览器 → WASM → Protobuf → Document Service → Undo/Redo → 重载闭环已关闭。R4 尚待更大规模的 100+ 节点组合 Golden 与独立验收，不阻塞当前基础交付语义。

补充（2026-08-16）：R4 的 101-layer Tidy up 回归现同时覆盖旋转的 Relative-v1 siblings 位于旋转、`clipsContent` Frame 内的组合。测试将前向和反向 selection 解析为同一 concrete update 集，再经 `resolveCoreBatch` 应用后以世界视觉 bounds 验证相邻间隙精确为 12；因此不再只验证简单局部 `x`，而是验证 Renderer/Clip 使用的世界空间交付结果。远端服务重放、重载和独立设计审核仍是未关闭验收。

### E1：Effect 真实语义

1. Core 保持 Effect Stack 顺序、可见性、颜色、offset、blur、spread 和 blend。
2. Canvas/WebGPU 使用相同合成顺序；无法由 GPU 等价实现时回退 Canvas，而不是降级 Document。
3. SVG 对可等价的 Shadow、Layer Blur、Inner Shadow 输出 filter；Background Blur、混合 stack 等无法等价时需明确 raster fallback 或 sidecar。
4. PNG/PDF 必须消费同一冻结 SVG/渲染源；不支持效果不可静默消失。
5. Device lost 后清除派生纹理，从最新 Snapshot 重建；第二次失败按既定策略稳定回退。

验收：色块、半透明图片、文本、Mask、Clip、混合 Blend/Effect 的 Golden；60 分钟修改无纹理泄漏；显式验证至少一次 device recovery。

当前落地（2026-08-16）：Effect Stack 的顺序、可见性和基础 Shadow/Layer Blur/Inner Shadow 已进入 Canvas 与 SVG 导出；Inspector 现可重排完整 Stack（包括跨 Effect 类型），且每次重排都会原子同步 legacy `dropShadow` 投影，避免后续 Snapshot/服务重放重新引入旧顺序。SVG 现在会将由 Layer Blur、Drop Shadow 和 Inner Shadow 单项组成的有序组合编译为一个逐步传递 `current` result 的 filter graph：Blur→Shadow 使用已模糊 alpha，Shadow→Blur 则模糊已合成 shadow/source；Inner Shadow 则从同一当前 alpha 经过 spread、blur、反向 offset、alpha clip 后再合成。因此 Layer Blur + Inner Shadow 也不再被静默降级，PNG/PDF 继续光栅化同一 SVG。Live Boolean Wrapper 现在也会以自身（而非首个 operand）的支持型 SVG filter 输出其 Effect；PNG/PDF 光栅化同一 SVG，避免 Boolean 的 Layer Blur 等效果静默消失。作为 alpha mask source 的节点同样参加 Effect 兼容性检查，因此 Mask 上未支持的 Background Blur/混合 stack 会有 node-id sidecar，而不会在 `<mask>` 内静默丢失。仍不支持的有序混合和 Background Blur 进入 sidecar。非零 Drop/Inner Shadow Spread 现遵循同一顺序：Canvas 在受预算的隔离表面中先对 SourceAlpha 作可分离 max/min morphology，再 Blur、Offset 与 Tint；SVG 使用 `feMorphology` 后接同样的 Blur/Offset，PNG/PDF 光栅化该冻结 SVG，因此不再产生 `shadow-spread` sidecar。WebGPU 对含 spread 的 Effect 仍明确回退 Canvas；Background Blur 与涉及不受支持混合的复杂 Effect Stack 仍属未关闭项。开发期 `?fixture=phase1-render-composite&simulateGpuLoss=1` 已在真实浏览器验证：当前 Device 销毁后状态回到 `WebGPU scene recovered (1)` 且 fixture 继续显示；`simulateGpuLoss=2` 则显示 `Canvas 2D · WebGPU recovery exhausted · device-loss simulation 2/2`。这证明两次路径都只清理并重建派生 GPU 资源，未修改 Core Snapshot；尚未替代 Effect/Mask/文本 Golden 与 60 分钟无泄漏门槛。

### L1：高级文本真实语义

1. 文本、Style Run、段落属性和 FontRef 必须在保存、Undo/Redo、服务重放中逐值一致。
2. DOM UTF-16 selection 与 Canonical UTF-8 range 的转换不能拆开 scalar、Emoji ZWJ 或 combining sequence。
3. 输入、IME、复制、剪切、私有富文本粘贴和不可信 HTML 回退都需原子提交。
4. Canvas、SVG、PNG、PDF 对同一冻结 Style Run 使用相同字体资源策略；SVG 嵌入已授权的受限字体，无法嵌入时报告 `font-asset`。
5. RTL/BiDi、CJK、Emoji、缺字 fallback 和受限宽度换行必须进入固定 fixture。

验收：复杂脚本、IME、屏幕阅读器独立复核、字体缺失降级、文本修改仅影响必要 Auto Layout 子树。

当前落地（2026-08-16）：Style Run、UTF-8 range、FontRef、fallback Fonts 和变量字体轴已经贯通 Core/Protobuf/WASM；Canvas 文本 fallback 与 SVG tspan 均消费同一组 `variationAxes`，并在 SVG 中安全序列化为 `font-variation-settings`。对于单一完整 Run，或连续覆盖全文且仅改变颜色等 paint 属性的同一字形度量多 Run，导出阶段会用与 Canvas 相同的 ICU4X/Rustybuzz 断行接口冻结 UTF-8 line range；当前 Rust 请求显式传入 font face 与 variable axes，但**不**传入浏览器合成的字重、斜体或 letter spacing，因此只有 `fontWeight: 400`、非 italic、零 tracking 的显式 regular span 才能冻结；默认 500 weight、CSS 合成样式或其他度量变化会明确保留浏览器 fallback 并产生 `text-layout` sidecar，避免将原始 face 的错误断行伪装为跨渲染器一致。`F-PHASE2-PROFESSIONAL-COMPOSITE` 的标题现以 UTF-8 边界固定四段 Latin/CJK/Arabic/Emoji paint Run，避免把“mixed Style Run”只停留在文档描述。SVG 直接消费该 projection，PNG/PDF 光栅化该 SVG，软换行不再被折叠，paragraph spacing 也只出现在显式段落分隔处。Canvas 每个 Style Run 现按 Canonical 主字体 → 已加载 fallback Fonts → 系统字体构建字体链，和 SVG/PNG/PDF 的嵌入字体策略一致。SVG 每个段落行直接消费冻结投影给出的 `direction`、`unicode-bidi=plaintext` 和视觉起始边（RTL 左对齐从右边开始），不再按截取文本二次猜测方向；与 Canvas 的段落基方向规则保持一致。服务 Snapshot 回归还固定了跨非 BMP scalar 的 UTF-8 Style Run 边界、主/备用 FontRef、变量轴、段落与 Auto Size 的 hash 完整往返。缺字的 shaping、IME 与跨平台字体回退 fixture 仍未关闭。

补充（2026-08-16）：专业综合夹具的独立真实浏览器会话已通过 Canvas `contentEditable` 进入标题编辑态，并以 `compositionstart → insertCompositionText → compositionend` 提交附加 CJK scalar。提交后 Inspector 的 Canonical 文本精确为 `Design · 中文 · مرحبا · 👋中`、document hash 发生改变；**Reset demo** 后文本与 fixture hash `b4d9c9d39a0f…` 一并恢复，控制台为 0 error。该流程现由 `scripts/capture-phase2-professional-composite-ime-evidence.sh` 可复跑：它同时断言 composition 后文本、Canonical mutation、编辑态关闭、Reset 恢复和控制台。该检查证明当前浏览器的 composition 提交不拆分现有 Emoji/CJK 文本，也不会绕过 Core；它是单浏览器候选，不能替代真实输入法、缺字 shaping 和跨平台 fallback 的独立验收。

### L2：Constraints 收口

1. 普通 Frame child 在 min/center/max/stretch/scale 下使用同一局部矩阵公式。
2. Frame resize 遇到旧几何 child 时，完整迁移到 Relative-v1，禁止一半 Legacy、一半矩阵。
3. Reparent、Group、镜像、零尺寸、Clip、连续 resize 均不漂移。
4. Auto Layout scope 内 Constraints 持久化但不参与二次计算；Inspector 显示 NotApplicable。

当前落地（2026-08-16）：`min/center/max/stretch/scale` 已在 Rust Core、Protobuf、WASM、Snapshot、Document Service 与 Inspector 闭环。旋转/仿射 Frame 调整会把 Legacy 直接 child 及其 Group 链子树迁移到 Frame-local Relative-v1，再按相同约束公式计算，防止连续 resize 漂移；嵌套 Frame、Section、Boolean 仍是独立布局边界。普通 Frame 的远端 `UpdateGeometry` 现有服务端集成回归：`max/stretch` child 在 100×100→200×160 后得到 `(x:120, y:10, width:40, height:80)`，持久化快照重载后约束值与几何一致。活跃 Auto Layout 作用域会保留旧 Constraints，但 Core 不再对它们二次计算，Inspector 明确显示 NotApplicable。跨层 Golden 与独立验收仍待关闭。

### L3：Auto Layout 真实语义

1. Rust Core 拥有最终 layout 语义，按祖先 Dirty Set 局部回流。
2. 支持 Horizontal/Vertical、Padding、Gap、Alignment、Hug、Fill、Fixed、Min/Max、Wrap、Absolute、三层嵌套。
3. 文本内容或字体变化只重算相关 Frame 祖先链，不得默认整页重算。
4. Reparent、Delete、PositionId 重排同时标脏旧/新容器。
5. Layout 结果进入 Canvas、SVG、PNG/PDF 的同一冻结 Snapshot；导出不能重新以浏览器 DOM 测量布局。

验收：Button、Input、Card、List、Form、三层嵌套、RTL 受限宽度、Wrap、Absolute、导出和服务重放。

当前落地（2026-08-16）：ChildLayout 的 `alignSelf`（inherit/start/center/end）已作为 Snapshot v21 的可选追加字段贯通 Rust Core Hash/Undo/Redo、Protobuf、Document Codec/Service、WASM 投影与 Inspector；协议层会为带 child-layout 的非 Frame 节点生成 `setAutoLayout`，使其与 Frame layout 同样可持久化、服务重放和重载。其值覆盖父 Frame 的交叉轴对齐，`counterSizing: fill` 保持 Stretch 语义。旧 Snapshot 因字段缺省仍保留既有 Hash；r85 的真实远端 Arrange→reload 验证覆盖了该新增字段的服务往返。`LAYOUT_ALIGNMENT_BASELINE = 5` 已作为 append-only Protobuf 枚举贯通 Codec、Service、WASM、Inspector 与 Core：水平 Frame 的 counter axis 可选 Baseline，纵向 Frame、primary axis 和 child `alignSelf` 会在边界被原子拒绝；Core 采用与 Canvas 无字形度量 fallback 一致的 CSS line-box baseline（而非错误地将 baseline 简化为 line-height 的 80%），并覆盖 Text、非 Text 与服务 Snapshot 往返。`trackSpacing` 也以 append-only optional field 进入同一路径：Wrap 中主轴仍使用 `itemSpacing`，行/列之间可以指定独立 gap；字段缺省则保持旧 Snapshot 使用 `itemSpacing` 的行为，显式 0 与缺省可区分。新增 `trackAlignment: spaceBetween` 映射 Figma `counterAxisAlignContent`：只在 Wrap 下可用，将固定容器交叉轴的剩余空间均分到 track 之间；非 Wrap 的外部输入原子拒绝，`auto` 继续使用 trackSpacing/旧 itemSpacing。Grid、复杂文本 Wrap 与完整跨格式/独立验收仍是 L3 的未关闭项。

补充（2026-08-16）：SVG 导出回归现固定一个 Wrap、`trackSpacing`、`trackAlignment`、`alignSelf` 与 absolute child 同时存在的 Frame。它刻意使 child 的 Relative-v1 位置不等于任何浏览器即时回流可推导的结果，并验证 SVG 只输出 Core 已冻结的世界矩阵（flow child `227,111`、absolute child `291,153`），不输出或重新解释 item/track gap。因此 PNG/PDF 光栅化该 SVG 时也不会与 Canvas/Canonical geometry 发生第二套布局。

### X1：导出与交付语义

```ts
type ExportManifest = {
  format: "makefigma-export-compatibility-v2"
  sourceRevision: number | null
  target: { pageId?: PageId; nodeIds?: NodeId[]; sliceId?: NodeId }
  formatRequested: "svg" | "png" | "pdf"
  colorProfile: "srgb" | "display-p3-fallback"
  transparency: "preserved" | { matte: `#${string}` }
  warnings: string[]
  fallbacks: CompatibilityFallback[]
}
```

要求：

1. 导出开始即冻结 nodes、pages、assets、revision、WASM 派生 Boolean/Vector/Parametric paths。
2. SVG 以可审计结构输出；不可信资源绝不原样注入。
3. PNG 由同一 SVG/渲染输入生成，保持透明背景或指定背景。
4. PDF 允许 RGBA raster + alpha soft mask；必须标记 `pdf-rasterization`，不能宣称为可编辑 vector PDF。
5. SVG、PNG、PDF sidecar 都记录 `sourceRevision`；多页 PDF 以 Canonical Page PositionId 排序。
6. 图片、字体、Display P3、Mask、Effect、Boolean、Slice 的任何 fallback 都必须携带 node/target ID、能力、原因和处理结果。

当前落地（2026-08-16）：每份 SVG、PNG 与单页 PDF sidecar 已由同一个 `ExportManifest` 构建器生成，包含冻结 `sourceRevision`、精确 page/node/slice target、请求格式、sRGB/P3 fallback、透明或 matte 策略、warning 和结构化 fallback。PDF 的 `pdf-rasterization` 现在由该构建器无条件写入（透明输出明确记录 PDF 1.4 alpha soft mask），因此任何新的 UI 或 API 调用方都不能漏报“非可编辑 vector PDF”的格式降级。导出开始会在同一 Snapshot 捕获 Boolean、Vector、Parametric 和可用的单字体 Text line projection；SVG 是这些临时派生数据的唯一消费点，PNG/PDF不会再次测量文本或几何。若引用文档字体的 Text 未获得这份冻结 projection，sidecar 会按节点写入 `text-layout`，说明 SVG 浏览器行布局可能与 Canvas 不同；系统字体的既有浏览器布局策略不作误报。创建/fixture 水合的 `isMask` 会在同一 Core Transaction 的全部结构创建与重排完成后写入专用 `SetMask`，避免它早于同批次的后续 sibling 而被 Core 拒绝，同时保留初始 Snapshot、Undo/Redo 与服务重放的 alpha-mask 语义。无历史 WASM hydration 也会在所有 `Create` 完成、Auto Layout 回流后应用同一批延后 `SetMask`，因此专业 fixture 不会为恢复 Mask 而回退到 TypeScript 原型或伪造用户 revision。选择图层导出会将目标子树扩展为所需的 ancestor structure 与各层生效的前置 alpha-mask source；这些 ancestor 仅提供 Clip/Mask 结构，不会额外绘制未选择父节点。图片 alpha mask 使用经授权的内嵌 raster 只写入 SVG `<mask>` 定义，目标层与 PNG/PDF 的同一冻结 SVG 输入共用该 source；字节不可用时仍按 `image-asset` 可见降级。专业综合 fixture 已在真实浏览器重载后验证 Inspector 的 `Use as alpha mask` 持续选中，且仅导出 `Masked texture target` 的 SVG 带有 `mask-type="alpha"`。PNG 和 PDF 都可保留透明度或选择任意不透明 `#RRGGBB` matte，sidecar 会规范化记录实际 matte；多页 PDF（所有 Page 或同一次导出的多个 Slice）生成**一份**按生成页顺序排列的 manifest set，逐页保留相同字段和各自的 `pdf-rasterization` fallback，并在 set 顶层只记录**一个** `sourceRevision`；构建器会拒绝混合 revision 的页，绝不把一份 PDF 误报为多份无关联或混合快照的交付。原生可编辑 vector PDF、完整 Effect raster fallback 与独立交付验收仍未关闭。

补充（2026-08-16）：`fixtures/documents/phase2-figma-rest-multipage-pdf.fixture.json` 是用于 PDF 页序的可公开复跑 REST 两页输入：首页以椭圆 Alpha Mask 裁切半透明洋红 target，第二页为青色卡片与蓝色 ellipse。该 JSON 经真实顶栏 **Figma JSON** 入口提交到 Worker/WASM 后，**Export all Pages PDF** 生成一份 3 页 PDF（既有 Page 1 + 两个按导入 `CANVAS.children` 顺序创建的页面）。真实 sidecar 记录单一 `sourceRevision: 1`、`transparency.matte: "#fef3c7"`，且三个 target 都带 `pdf-rasterization`；Poppler 页图中第 2 页为被裁切的紫色椭圆、第 3 页为独立的青/蓝画面。该候选证明页序、matte、Alpha Mask 与 manifest set 的端到端路径，不替代独立 Golden、跨平台视觉阈值或 60 分钟门禁。

补充（2026-08-16）：同一延后写入规则也覆盖复制粘贴及以新 Vector 替换旧图层的 Boolean Flatten、Line Outline、Parametric→Vector；替换后的 Vector 继承原图层的 alpha-mask 身份。回归测试固定了“所有结构命令先完成、`SetMask` 最后写入”的顺序，避免远程服务回放在目标 sibling 尚未存在时拒绝事务。

Figma 的导出设置支持 PNG/JPG、SVG、PDF，并指出 SVG Text 与 Outline 的可选择性/视觉一致性取舍；本项目应以此作为策略开关，但无需承诺像素级复刻 Figma 私有渲染器。 [Figma ExportSettings](https://developers.figma.com/docs/plugins/api/ExportSettings/)

## 6. 导入与兼容性策略

### 6.1 Figma REST 导入

1. 调用文件读取时请求 paths 几何；REST 的 `GET file` 和 `GET image` 属于读取/渲染接口，不能作为编辑写入通道。
2. 先验证文件版本、节点数、路径字节、图片/字体下载大小、递归深度和 transform 有效性。
3. 将可支持字段转换为一笔或分批 Canonical Transaction；批次失败必须整体回滚。
4. 未支持字段写入 `extensions.figma`，同时在 import report 记录能力状态。
5. Image fill 下载 URL 有时效且渲染结果可能为 `null`；资源必须进入受授权 Asset Service，不能把外部 URL 长期写进 Document。

Figma 的文件和图片端点要求相应读取权限，节点渲染可能因不可见或不可渲染而返回空结果。 [Figma file endpoints](https://developers.figma.com/docs/rest-api/file-endpoints/)

当前落地（2026-08-16）：`planFigmaRestImport` 已作为不可信 REST JSON 的纯预检/映射边界落地。它在任何 Core 事务之前限制页面树深度、节点数和 Vector SVG path 源字节，分离 Page 创建命令与普通节点创建命令；`resolveFigmaRestImportBatch` 将它们排列为“所有 `CreatePage` 在前、所有节点与延后 `SetMask` 在后”的单一 Core/WASM/Protobuf batch。`MainToWorker.import-figma-rest-plan` 只接受这个已预检的 plan 与当前 base revision，随后走和普通编辑相同的 Core 提交、Undo、snapshot journal 与远端 operation queue；它不接收 token、外部 URL 或资源字节。该 batch 任一命令被 Core 拒绝即整体不提交，并可作为一个远端 `ResolvedOperationBatch` 重放。Frame、Group、Section、基础形状、Text、Slice、Boolean、透明度、可编辑的 SOLID Paint、四类 Core Effect、Alpha Mask、Constraints 以及 Horizontal/Vertical Auto Layout 映射为 Canonical 候选。没有任何已导入后续 sibling 的 Alpha Mask 会显式降级为保留的 mask metadata，避免生成必然被 Core 拒绝的事务。GRID、非 Alpha Mask、未知 Blend/Effect/Paint、未知 NodeKind 与未安全转换为 PointId 的 Figma SVG Vector path 都不会被伪造成已支持语义：分别写入结构化 import issue 或受限 extension。

### 6.1.1 图片授权与绑定协议（本地文件入口已落地；账号 OAuth 待接入）

Figma 的 `GET /v1/files/:key?geometry=paths` 返回结构和可编辑路径；`GET /v1/files/:key/images` 返回 image-fill `imageRef → 临时下载 URL` 映射。后者的 URL 最长仅 14 天有效，且结果不应成为 Canonical 字段；渲染端点 `GET /v1/images/:key` 的节点结果也可能是 `null`。因此导入必须按下面的两阶段协议执行，而不能从 REST JSON 直接创建带外链的 Image Node。 [Figma file/image endpoints](https://developers.figma.com/docs/rest-api/file-endpoints/)

| 阶段 | 输入/输出 | 落点与不可变条件 |
| --- | --- | --- |
| A. 读取和预检 | `GET /v1/files/:key?geometry=paths` → `FigmaRestImportPlan` | 只读取；限制深度、节点数、path 字节、矩阵；不存 token/URL/bytes |
| B. 结构提交 | `resolveFigmaRestImportBatch(plan)` → `createPage/create/setMask` | 单 Core Transaction；Page 在前、Mask 在全部 sibling 后；本地 JSON UI 已接入 |
| C. 资源解析 | `assetRequests[]` + 服务端 OAuth/访问令牌 → 临时 URL → 下载 bytes | 必须在服务端或受控代理执行；限制响应类型、魔数、像素、字节、重定向与下载超时 |
| D. 资产准入 | bytes → Asset Service → `DocumentAsset` | 上传、SHA-256、媒体校验、document writer attachment 均成功后才得到 `assetId` |
| E. 原子绑定 | `FigmaRestAuthorizedAsset[]` → `bind-figma-rest-assets` | 同一 batch 先 `registerAsset`，后完整 `update`；进入 Undo、日志与远端 replay |
| F. 像素缓存 | 仅已准入 bytes → transient `asset-bytes` | 不进入 Snapshot/Operation；失败只影响渲染，并产生 `image-asset` fallback |

实际协议类型：

```ts
type FigmaRestAssetRequest = {
  sourceId: string
  nodeId: NodeId
  imageRef: string
  usage: "fill" | "stroke" | "node"
}

// 唯一允许跨授权边界进入 Worker 的资源对象：没有 URL、token、Cookie 或 bytes。
type FigmaRestAuthorizedAsset = {
  request: FigmaRestAssetRequest
  asset: {
    assetId: AssetId
    contentHash: Sha256Hex
    mediaType: `image/${string}`
    byteLength: number
    pixelWidth?: number
    pixelHeight?: number
  }
}

type BindFigmaRestAssets = {
  type: "bind-figma-rest-assets"
  transactionId: TransactionId
  baseRevision: number
  authorized: FigmaRestAuthorizedAsset[]
}
```

`resolveFigmaRestAssetBindings(currentNodes, currentAssets, authorized)` 已执行以下可验证规则：AssetId 与完整 immutable metadata 冲突时拒绝；只允许 `image/*`、合法 SHA-256 和正尺寸的资源；只允许 Frame、Section、Rectangle、Ellipse 或已有 Image 的单一 image fill；`stroke` image 和一个节点的多个 image paint 均不猜测优先级，而是保留并报告。每个新 Asset 在同一 batch 的 `registerAsset` 先于它的 `update`，因此 Rust Core 不可能提交 dangling `assetId`。被导入的 Figma `IMAGE` 节点会先安全表示为 Rectangle 占位并保留 `figma.rest.image-node.v1`，待授权资源到达后再绑定；带图片的 locked 图层将 lock 临时记录为 `figma.rest.deferred-lock.v1`，并在同一绑定事务恢复，避免 Core 的锁定写入保护阻断资源绑定。

`figmaRestImportReport(plan)` 会产出稳定的 `makefigma-figma-rest-import-report-v1`：页数、图层数、待授权图片数、rejected/omitted/preserved-extension 计数和原始结构化 issue。编辑器顶栏的 **Figma JSON** 已可导入用户从 REST 导出的 JSON，并提供 **Import report** 下载；它在不具备 Figma 授权时仍可交付结构、Vector、Boolean、Mask、布局和所有可映射字段，并会明确提示待授权图片。对可绑定的 fill/node `imageRef`，顶栏会按 REST 来源顺序显示 **Attach Figma image**：用户选择对应的本地 PNG/JPEG/WebP 后，仍先经过 Asset Service 的探测、解码、上传与 document attachment，再发送 `bind-figma-rest-assets`；成功后才从待处理队列移除。图片描边和一个图层多 image paint 继续只出现在报告中，不会由此 UI 猜测绑定。

此边界已经由 `src/lib/figma-rest-import.ts`、`src/lib/editor-protocol.ts`、`src/workers/editor.worker.ts` 与 `src/components/editor/editor-shell.tsx` 实现。尚未交付的是“输入 Figma URL / OAuth 登录 / 从账号选择文件”和服务端受控下载代理；在该入口交付前，不得宣称产品已能直接从 Figma 账号读取文件或自动导入图片。

补充（2026-08-16）：`geometry=paths` 的 `VECTOR.fillGeometry` 现在会按 Figma 的相对节点 path 语义转换为 Canonical `VectorPath`：`M/L/H/V/C/S/Q/T/Z` 生成稳定 PointId、闭合标记与可编辑 cubic handle；`Q/T` 精确变换为 cubic handle，`EVENODD/NONZERO` 对应 Canonical fill rule。`A/a` 椭圆弧按 SVG endpoint-arc 规范分割为最多 16 个、每段最多 22.5° 的 cubic，并将原始 `fillGeometry` 保留为 `figma.rest.vector-arc-source.v1` 与 `vector-arc` import issue；因此后续可编辑的是明确的 cubic 近似，源弧参数不会被伪称为 Canonical 原语义。导入前同时执行与 Rust Core 一致的 64 subpath、8192 point、1 MiB path-source 约束。混合 winding rule、畸形命令、非法 arc flag 或无法分配稳定 PointId 的 path 继续显式拒绝/报告，绝不近似成错误的可编辑形状。

补充（2026-08-16）：REST `TEXT.style` 的 font size、weight、italic、letter spacing、horizontal alignment、line-height、paragraph spacing 和 auto-resize 现在可进入 Canonical TextProperties；ASCII `characterStyleOverrides` 会合并连续样式并以 UTF-8 byte range 写入 runs。为了不猜测 Figma 在复杂 Unicode 文本中的 override 索引，Emoji、ZWJ、组合字符或非法 override table 会保留原始字段并仅写入一个有效的 base run。Figma font family 仍只作为受限 metadata 报告，必须经 Asset Service 附着实际字体字节后才能成为 Canonical FontRef。

补充（2026-08-16）：REST Page 与每一层 `children` 数组的顺序现在直接转换为稀疏 Canonical `PositionId`，不再从调用方生成的 UUID 推断排序。`EditorCommand.create-page` 现可携带该 position；Worker 通过 `create_page_at_position` 写入 WASM，并在离线重放时使用同一入口，随后远端仍编码既有 `encodeCreatePagePayload`。因此，调用方按 Planner 的 Page commands 再提交 node batch 时，多页排序、Layer panel、PDF Page 顺序及“前置 alpha-mask source → 后续 target”在本地、重放与服务操作中保持 Figma 来源顺序；普通 UI 不传 position 时仍保留既有 ID 推导的创建行为。编辑器已支持用户选择已下载的 REST JSON，但 Figma 账号的文件选择、鉴权和受控下载代理尚未接入；不能将这一离线入口误称为完整账号级导入。

补充（2026-08-16）：请求 `geometry=paths` 时，REST 的 `size` 是未经过缩放/旋转的本地尺寸，而 `absoluteBoundingBox` 已是变换后的 bounds；导入器现优先使用前者，并将完整 2×3 `relativeTransform`（`a,b,c,d,e,f`）写入 Canonical。旋转、缩放、镜像与倾斜不再被错误压缩成平移加角度；矩阵必须有限且可逆，否则整个节点按 geometry 输入拒绝。该矩阵在 Canvas、Hit Test、SVG 与 Core 的相对变换路径中保持同一语义。 [Figma REST geometry fields](https://developers.figma.com/docs/rest-api/file-node-types/)

补充（2026-08-16）：REST Paint 现支持可等价的 `GRADIENT_LINEAR`。Figma 的三项 normalized `gradientHandlePositions` 中，前两项映射为 Canonical `start/end`，各 stop 的 RGBA 与 paint opacity 合并进 Canonical color；多层 fill/stroke 顺序保留为 Paint Stack。第三 handle 决定 gradient width/等色线方向，因此仅当它与 start→end 轴正交（Canvas/SVG 的线性渐变能精确表达）时才进入 Canonical；倾斜、退化、无序/超限 stop、非 `NORMAL` paint blend 及其它 Paint 类型均原样写入受限 extension 和 import report，绝不近似为不同的渐变。该约束对应 Figma REST 对 Paint、三个 gradient handle 与 0–1 stop position 的定义。 [Figma Paint property type](https://developers.figma.com/docs/rest-api/file-property-types/)

补充（2026-08-16）：REST Basic Stroke 与参数图形外观现进入已有 Canonical 字段：`strokeWeight`、`strokeCap`、`strokeJoin`、`strokeDashes`、允许范围内的 `strokeAlign`，以及 Frame/Rectangle 的 `individualStrokeWeights`；`cornerRadius`、四项 `rectangleCornerRadii`、`cornerSmoothing` 在 Frame/Rectangle/Section 中可编辑。Ellipse 的 `arcData.startingAngle/endingAngle` 按 Figma REST 的弧度语义转换为 Canonical 的度数，`innerRadius` 只接受 `(0, 1)`。`WASHI_TAPE_*` cap、`strokeMiterAngle`、动态/非 BASIC `complexStrokeProperties`、variable-width stroke、非法 dash/圆角/arc 值，或超出 Core 节点适用范围的字段均保存到 `figma.rest.unsupported-stroke.v1` 并报告；不会被替换成看似接近的普通描边。 [Figma REST node fields](https://developers.figma.com/docs/rest-api/file-node-types/), [Figma REST ArcData](https://developers.figma.com/docs/rest-api/file-property-types/)

补充（2026-08-16）：`exportSettings` 现原样持久化为 `figma.rest.export-settings.v1`，同时生成 `export-settings` import issue。Figma 的节点 preset 包含 PNG/JPG 的尺寸约束、SVG 的 text outline/ID/stroke 简化策略、PDF，以及颜色 profile 等选项；它们不能在导入时隐式触发下载，也不能在尚无 Canonical per-node preset 的情况下改写本地导出控制。当前 MakeFigma 的 SVG/PNG/PDF 仍由用户显式选择的冻结导出配置决定；后续若新增可执行 preset，必须以 append-only Core 字段和目标/资源/预算校验接入，而不是读取这段 extension 后直接执行。 [Figma ExportSettings](https://developers.figma.com/docs/plugins/api/ExportSettings/)

### 6.2 兼容性分级

| 级别 | 含义 | 行为 |
| --- | --- | --- |
| Supported | Canonical、渲染、编辑、导出语义完整 | 不写 warning |
| Raster fallback | 可视觉交付但不可保留为矢量/可编辑 | 产物 + sidecar |
| Preserved extension | 不编辑但尽量无损保留外部字段 | 只读/导入报告 |
| Unsupported | 无安全或确定性实现 | 原子拒绝或显式省略 + sidecar |

## 7. 实施顺序

```text
R0/R2 基线与独立审核
  ↓
R4 Align / Distribute / deterministic Tidy up
  ↓
G1–G5 几何、Boolean、Mask、Slice 跨渲染闭环
  ↓
E1 Effect 合成与降级语义
  ↓
L1 文本、L2 Constraints、L3 Auto Layout
  ↓
X1 冻结导出、资源嵌入、PDF、sidecar
  ↓
Q1 Golden、60 分钟稳定性、独立 AT/设计审核
```

R4 应在 L3 之前进入实现：它依赖稳定 Transform/Bounds，但其 Auto Layout 规则必须使用 L3 已冻结的 `positioning` 与 `alignSelf` 语义，避免把 flow child 的坐标当成可自由整理的值。

### 7.1 可执行交付清单

下表把“当前已落地”与“可以宣称完成”分开。`Partial` 表示功能代码已存在，但尚缺该行列出的验收证据；未通过验收前不能在产品说明中标为完成。

| 优先级 | 工作包 | 当前状态 | 下一项可执行交付 | 完成定义（DoD） | 证据/产物 |
| --- | --- | --- | --- | --- | --- |
| P0 | G1–G5 Vector / Boolean / Mask / Slice | Partial | 为专业综合 fixture 增加 Canvas、SVG、PNG、PDF 像素 Golden；覆盖嵌套 Clip、Alpha Mask、Live Boolean、Flatten、Slice 选择导出 | 四个输出对同一 `sourceRevision`、同一 Boolean/Vector 派生路径；任何不支持项均有 node-id sidecar | fixture、Golden 基线、manifest JSON、失败 diff 图 |
| P0 | X1 PDF | Partial | 固化多页 PDF 的 page-order、透明/matte、alpha mask 与 fallback manifest 端到端回归 | 页序等于 `Page.positionId`；每页都有 manifest；PDF 始终含 `pdf-rasterization`，不得声称可编辑矢量 PDF | 多页 PDF fixture、PDF 页图、manifest 集合 |
| P0 | E1 Effects | Partial | 覆盖 Effect × Mask × Boolean × Text 的 Golden，并完成一次连续 60 分钟编辑资源稳定性测试 | 受支持效果在 Canvas/SVG/PNG/PDF 一致；Background Blur/复杂 stack 必有 fallback；无纹理/离屏面泄漏 | Golden、资源计数日志、device-loss 记录 |
| P0 | L1 Text | Partial | 补齐缺字 shaping、IME、CJK/RTL/Emoji 与跨平台 fallback fixture | UTF-8 selection 不拆 scalar；冻结 line projection 在四种输出一致，无法嵌入字体有 `font-asset` | 文本 fixture、服务重放测试、导出 sidecar |
| P1 | R4 Arrange | Partial | 新增 100+ 层旋转/嵌套/Clip/Auto Layout 组合 Golden 和独立验收 | 前/反向选择产生同一 concrete batch；Undo/Redo、远端重放和重载 hash 一致 | arrange fixture、批次断言、远端回放记录 |
| P1 | L2 Constraints、L3 Auto Layout | Partial | 覆盖三层嵌套、Wrap、RTL 受限宽度、Absolute、Reparent/Delete 的局部回流导出回归 | Core 是唯一布局结果；旧/新容器正确标脏；Canvas 与 SVG/PNG/PDF 不重新测量 | layout fixture、Snapshot/服务回放、导出 Golden |
| P1 | Figma REST 本地导入 | 已可交付（离线） | 持续扩充有等价映射的节点字段；保持未知字段显式报告 | JSON 预检、单事务结构导入、Vector/Boolean/Alpha Mask/布局、导入报告和本地图片绑定可用；不得存 URL/token/bytes | `figma-rest-import` 单测、导入报告、Worker 事务测试 |
| P2 | Figma 账号级导入 | 未开始（需外部授权） | 配置 OAuth、服务端受控下载代理、账号文件选择与撤销机制 | token 仅服务端保存；下载有类型/大小/重定向/超时限制；仍复用本节资产准入与绑定协议 | 威胁模型、集成测试、审计日志 |
| P2 | Q1 独立交付审核 | 未开始 | 可访问性、视觉设计与性能独立审核 | 所有 P0 项通过后，对候选构建给出可复现 Go/No-Go 结论 | 审核报告、性能/稳定性数据 |

推荐执行顺序是先关闭前三项 P0：它们共同决定专业设计文件在 Vector、Boolean、Mask 与 PDF 上是否真的形成跨渲染器闭环；再进入文本和布局的规模化验收。OAuth 属于产品接入项目，依赖外部凭据和服务端部署，不应阻塞离线导入能力的交付。

## 8. Phase 2 完成门槛

只有同时满足以下条件，Phase 2 才能从候选变为可交付：

1. 所有 Required NodeKind 能保存、恢复、Undo/Redo、服务重放并保持 Hash 一致。
2. Canvas、Hit Test、选择 Bounds、SVG、PNG/PDF 使用同一冻结几何、裁剪、Mask、布局输入。
3. Align/Distribute/Tidy up 具备 Canonical Transaction 与 Auto Layout 适用性规则。
4. Text、字体、Effect、图片、Display P3、Boolean、Mask、Slice 的降级均可见且可机器读取。
5. 每份导出产物可通过 `sourceRevision`、目标 ID 与 sidecar 追溯。
6. 专业综合 Fixture 通过功能回归、浏览器控制台检查、性能 Gate、60 分钟稳定性、Golden、独立可访问性与设计审核。

在上述门槛满足前，文档应继续使用“候选”或“Partial”，不得因局部浏览器演示成功而标记整项完成。

### 8.1 当前 P0 证据操作约定（2026-08-16）

专业综合夹具的采集命令会固定 1440×960、DPR 1、`?fixture=phase2-professional-composite`，并在截图产生后立即运行 `verify-phase2-professional-composite-golden.mjs`。采集目录必含 `golden-verification.json`，`evidence-metadata.json.goldenVerification` 复制同一结构化结果，二者均带 SHA-256 归档；因此候选、夹具漂移、缺失基线和已评审基线不匹配可区分追溯。已评审时，验证器在校验基线 SHA 后会硬性验证 PNG 也是 1440×960，拒绝超出固定 1440×960 像素预算的输入；随后才按非交错 8-bit RGB/RGBA PNG 的实际 RGBA 像素与 `pixelTolerance` 比较，不会因 PNG 压缩或元数据不同误报；无效图片也返回结构化 `INVALID_PNG`。不匹配的同尺寸或尺寸错误截图都会写入 `golden-diff.png`：匹配区域为低亮度基线，变化或缺失像素为洋红色，并作为证据元数据中的 SHA-256 产物而非新的基线。清单的 `fixtureSha256` 已同步到当前 24-node fixture；截图基线仍为 `pending-reviewed-baseline`，不得由采集脚本写入或替换。退出码 `2` 表示“待独立评审基线”，不是通过；`0` 才表示已评审 Golden 一致，其他非零表示采集失败或回归。

补充（2026-08-16）：在 `?fixture=phase2-professional-composite` 的真实浏览器会话中，顶栏的 **Export SVG / PNG / PDF** 已分别产生单页交付；SVG 产物含一个顺序执行的 `Layer Blur → Drop Shadow → Inner Shadow` filter（包括 `innerMask` 和 spread），并包含两个独立 alpha-mask 定义与引用。该 Compose bar 未在 sidecar 中声明 `layer-blur`、`inner-shadow` 或 `shadow-spread` fallback；仍不支持的 Background Blur、无法冻结的复杂文本、不可内嵌图片等会逐 node 明示。PDF 产物经 `pdfinfo` 验证为单页 PDF 1.4，sidecar 额外且明确给出 `pdf-rasterization`：它是带 alpha soft mask 的无损 RGBA 栅格，而非可编辑矢量 PDF。该浏览器回归保存 SVG、PNG、PDF、sidecar 和 Poppler 页图，作为导出契约候选证据；它不替代 1440×960 Golden 基线的独立冻结、像素 Gate 或 60 分钟稳定性门禁。

补充（2026-08-16）：连续 Wheel 交互已改为“每个输入帧完成 Offscreen Canvas render、最多每 50ms 回传一次完整 View State”，避免 React/Worker 消息竞争被错误计入可视渲染路径；交互期间的 backing-store DPR 是 50%，空闲 160ms 后恢复原生 DPR。固定 1440×960、DPR 1 的三轮真实浏览器 smoke 记录中位数为 render P95 `10.56ms`、input→render P95 `16ms`、input backlog P95 `0.1ms`，三项本地 Gate 均通过，控制台为 0 error。正式 3,600 秒候选采集随后以同一已测试源码启动；它完成前不得把本段当作 60 分钟 Gate 已关闭。

补充（2026-08-16，采集失败记录）：该次正式候选在收尾前已归档 31 个连续交互循环，31 份 action、move 与 memory 记录均存在，浏览器控制台为 0 error；但第 16 份 `performance-run-0016.txt` 为 **0 字节**。Playwright 进程对这次空响应返回了成功，旧采集器未在当轮拒绝，最终性能汇总因缺少完整 input/render metrics 而退出。因此该目录 `output/playwright/phase2-professional-composite-stability-20260816T132000Z` 是失败证据，**不**构成 60 分钟 Gate 候选，也不应从其余 30 份指标推导通过结论。采集器现会在每一轮完成后解析刚归档的性能结果：首次空文件、不可解析 JSON 或缺少 input/render 字段会保留为 `*.initial-invalid.txt` 并在**同一轮**有限重试一次；重试仍无效才写入 `stability-failure.log` 并失败。对应单测覆盖“命令成功但性能归档为空”的情形。需在冻结源码、独立无热更新的环境重新运行完整 3,600 秒采集，之后仍须 Golden 独立冻结和审核。

补充（2026-08-16，第二次采集失败记录）：独立生产服务器上的第二次正式候选在 31 个连续交互循环后同样不能关闭 Gate：`memory-run-0021.txt` 与 `memory-run-0022.txt` 均为 **0 字节**，而相应 Playwright 命令错误地以成功状态返回。31 份 performance 归档均可解析、控制台为 0 error，但内存曲线不能补写或由相邻样本推断，故目录 `output/playwright/phase2-professional-composite-stability-production-20260816T142400Z` 仍是失败证据，不能作为稳定性候选。采集器现在对 performance **和 memory** 两类归档都在当轮解析；首次无效响应被保留并记录同轮重试，第二次仍无效才以 `performance-evidence` / `memory-evidence` 阶段停止。单测同时覆盖永久空响应的失败和一次空响应后的成功重试。下一次正式采集必须重新从 0 秒开始，仍在独立生产环境、冻结源码条件下运行满 3,600 秒。

补充（2026-08-16，第三次正式候选）：在独立生产服务 `http://127.0.0.1:3005`、固定 1440×960/DPR 1、冻结源码指纹条件下，目录 `output/playwright/phase2-professional-composite-stability-production-retry-20260816T153100Z` 完成了 **3,637 秒、31 个连续循环**。31/31 action、真实键盘 Canonical move、performance 与 memory 归档均齐全；起止截图、浏览器环境和 source fingerprint 均存在，console 为 0 error，未产生 retry、initial-invalid 或 failure 归档。性能中位数为 render P95 `10.105ms`、input→render P95 `17ms`、input backlog P95 `0.1ms`，三项本地门槛均通过；heap used 的 first/last 为 `12,030,609` / `12,706,090` bytes（delta `675,481`），完整曲线保留供独立审阅。`stability-summary.json` 的所有连续性、动作、键盘变更和控制台 gate 为 true，故 **60 分钟本地稳定性候选已闭环**。它仍是 `local-candidate`：Golden baseline 仍为 `pending-independent-review`，且可访问性/设计审核未签署，不能据此将整个 Phase 2 或 Q1 标为完成。
