# ADR 0006：Phase 0 色彩存储与转换边界

状态：已采纳（Phase 0 Spike）

## 决定

- Rust Core 的 `Color` 值始终显式携带色彩空间：`sRGB`、`Display P3` 或 `Linear sRGB`。
- 文档值以非预乘的 RGB 与 alpha 存储；仅在渲染器上传边界转换为线性 sRGB、预乘 alpha 的 RGBA。
- `Display P3` 到 sRGB 的降级在 Core 中以固定 D65 矩阵、线性光转换与目标色域裁剪完成，保证同一输入得到确定性输出。
- Phase 0 的渐变插值固定在线性 sRGB 中进行，不在编码 sRGB 中直接插值；8-bit 输出只在交付到 CSS/Canvas 等边界量化。

## 迁移边界

基础 Solid Color、`DocumentColorProfile` 与 2–16 stop 的 `LinearGradient` 已在 ADR 0015 中迁入 `Node.fill`/`Node.stroke: Paint`，并通过 Snapshot v9 的 `fillColor`/`fillGradient` 与 `strokeColor`/`strokeGradient` 跨 WASM、Worker、Journal 回放保留色彩空间。Canvas/CSS 的 `fill`/`stroke` 已降为显示回退字段，不能反向定义 Canonical 色彩；Canvas 2D 会绘制渐变描边，WebGPU 过渡层把它留给 Canvas 覆盖层。图片、真实广色域 Canvas/GPU 绘制、HDR 与导出仍未完成。

## 后果

后续将多重 Paint、更多渐变停止点和图片处理迁入 Canonical Schema 时，必须复用该值模型，并为 sRGB/P3 互转、alpha、量化和渐变增加 Golden fixture。实际 WebGPU 后端可直接采用 `to_render_rgba`，但不得改变持久化色彩的非预乘语义。
