# ADR 0021：Canonical Text 的正式栅格化边界

状态：已采纳（Phase 1；验收证据待 W3 矩阵冻结）

## 决定

Phase 1 不在浏览器 Worker 中引入 FreeType。正式 glyph rasterizer 是
`makefigma-graphics-core` 中基于显式 OpenType 字节、`ttf-parser` outline 与固定
4×4 even-odd supersampling 的 Rust 实现；它与 Rustybuzz shaping 和 ICU4X line
breaking 一起构成 Text Presentation Semantics v1。

- 输入只能是 Asset Service 内容寻址的字体字节、face index、按 tag 排序的 Variable
  Font 坐标、glyph ID 与受限 pixel size；不能使用 `FontFace`、Canvas 或系统字体。
- 同一组变体坐标必须同时进入 Rustybuzz shaping、`ttf-parser` outline raster 与 GPU
  texture cache identity。未知、重复、非有限或非可变字体轴一律拒绝，不能静默回落为
  默认实例。
- alpha mask、atlas 坐标和 WebGPU texture 是可丢弃派生资源；Canonical Document 仅
  保存 `FontReference`、文本与 style run，不保存像素或浏览器测量结果。
- Canvas/system text 仅是明确的 presentation fallback（例如混合 style run、RTL
  GPU pass 尚未实现、彩色/bitmap/CFF2 glyph 不能由本 rasterizer 表达）。它不参与
  Canonical layout、caret、操作重放或布局 hash 的判定。

## 取舍

FreeType 仍是成熟的 hinting 实现，但将其引入 WASM Worker 会增加目标构建、二进制、
字体安全面与跨平台 hinting 差异。当前 Renderer 使用固定的无 hinting alpha 规则，
因此同一字体字节和参数在浏览器、服务 fixture 与未来 native executor 有一个可重放的
事实来源。代价是小字号视觉效果不承诺与任一操作系统的 FreeType/CoreText/DirectWrite
逐像素一致，且 CFF2、bitmap 与 color glyph 仍需走明确降级或后续专用 raster pass。

## 验收与约束

W3 完成前不得将本决定解释为完整富文本引擎已验收。冻结前必须记录字体 SHA-256、
Text Presentation Semantics v1、布局 JSON 与 alpha Golden，并在 B1–B4 环境执行：

- Variable Font 至少两个坐标组合，确认布局、outline 和 texture key 都不同且可重放；
- 中英、Arabic/Hebrew、Indic、Emoji ZWJ、ligature 与缺失字体的布局 hash；
- glyph atlas 满、Device Lost 重建与 Canvas fallback 的明确诊断；
- 同一输入的跨平台 Golden 只允许已记录的无 hinting 容差，不能混入系统字体渲染。

如果这些证据显示 Rust rasterizer 不能满足受支持字体范围，后续 ADR 必须改为引入
FreeType 或缩小正式支持面；不得再添加第二个隐式 rasterization 事实来源。
