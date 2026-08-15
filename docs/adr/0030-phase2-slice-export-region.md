# ADR 0030：Phase 2 Slice 是无子节点的世界坐标导出区域

状态：已采纳（Phase 2 G5，首个可用切片）

## 背景

导出范围不能依赖临时的浏览器选择框，也不能把一个透明 Rectangle 当作约定：后者会进入正常 Paint、Mask 与命中语义，并会在不同客户端产生不一致的结果。架构 §7.2 已要求独立的 `Slice` NodeKind。

## 决定

- `Slice` 是专用的非绘制型 Canonical NodeKind。它有普通的正宽高 world geometry、旋转和 Relative-v1 parent transform，因此可以在 Layers 中选择、移动、Resize、重命名、锁定、隐藏、复制、删除及 Undo/Redo。
- Slice 不允许 children，也不能作为 Image、Boolean、Vector、Mask、Frame Clip 或任何 Paint/Stroke/Shadow 的宿主。Core 要求透明的 base fill/stroke、零 stroke width、无 Paint Stack/效果/圆角；这让所有客户端都能安全地把它从普通 page paint 中排除。
- Slice 可嵌在现有容器中，但它的区域始终由冻结 revision 的完整世界矩阵解析。Frame 的父级 transform 会影响 Slice；Slice 自身不会裁剪或改变其 parent/descendant 的普通编辑语义。
- 可见性只影响编辑器中的通常可见/可选投影；一个被明确选中的 Slice 仍可作为导出意图的区域。锁定仅禁止编辑，不禁止导出。
- 选中一个 Slice 后可导出 SVG、PNG 或 PDF，三者都从同一冻结 SVG 世界区域和旋转四边形 clip 派生。SVG 与 PNG 保持透明背景；PDF 以白底 JPEG 栅格页嵌入最小 PDF 1.4 容器，因此不承诺透明度或原生矢量内容。未选中 Slice 时 SVG 保持页面导出的历史行为。
- PNG/PDF 在分配 Canvas 前统一限制为单边 16,384px、64MP/256MiB RGBA、最高 8× 倍率；工具栏为选中的 Slice 提供 1×、2×、4×、8× 倍率，以及 PNG 的透明/白色背景选择。批量最多 32 个 Slice，累积 frozen pixels 也不得超过同一 64MP/256MiB 预算。PNG 逐张顺序导出，PDF 合为一个按 Slice 顺序排列的多页文件；超限会显式拒绝。PDF 仍固定白底；任意颜色背景、输出文件命名策略与跨格式兼容报告仍是 G5 后续切片。

## 后果

- Schema、Core Hash、Snapshot、Operation、Service 与 WASM 可保存及重放 Slice 而不依赖 UI 瞬态状态。
- Canvas/Worker、Hit Test 与 SVG 都排除 Slice 的普通 paint；选择 Overlay 继续通过几何显示它的编辑边界。
- 同一 Slice 在保存恢复或服务端重放后会用相同世界坐标导出；SVG 单测覆盖旋转裁剪，Core 单测覆盖无绘制不变量、不可当 Mask、不可承载 children 与 Undo/Redo。
