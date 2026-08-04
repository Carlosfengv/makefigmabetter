# ADR 0013：基础 Text 内容的 Canonical 化

状态：已采纳（Phase 0.8 基础）

## 决定

- `Node.text` 是 Rust Core 中的 Canonical 纯文本字段；仅 `Text` 节点可持有非空内容，单节点上限为 1 MiB。
- `SetText` 是独立的语义 Command，参与原子 Transaction、Undo/Redo、Operation payload SHA-256 与 Canonical document hash。
- WASM Core Snapshot 升至 schema v3，并序列化文本内容。schema v1/v2 仍可读取；它们缺少 Canonical text，加载时不再校验旧哈希，Worker 会从旧 presentation sidecar 恢复历史展示文本。
- 新写入的 Snapshot 不再把 `text` 放进 presentation sidecar；Snapshot v8 将 rotation、v9 将 stroke 与 stroke width 移入 Canonical Core。
- Canvas 2D 过渡渲染按显式换行、宽度、Unicode 字素簇安全的贪心换行显示文本，并裁剪到 Text 节点框；`CRLF`、`CR`、`LF`、Line Separator 与 Paragraph Separator 都归一为显式段落边界。可用时采用浏览器 `Intl.Segmenter` 的 grapheme 切分，以覆盖 Hangul Jamo、键帽 Emoji、旗帜等完整字素簇；不支持时采用受限确定性回退。组合字符、Variation Selector、Emoji modifier 和常见 ZWJ Emoji 不会被换行拆开。给定同一字体测量结果，该算法是确定性的。

## 后果

文本编辑现可确定性重放、持久化并被语义撤销，Canvas 2D 也拥有可验证的基础换行和裁剪行为：在将逻辑 UTF-8 文本交给浏览器 Canvas 塑形前，过渡布局器会按 Unicode 第一个强字符确定 LTR/RTL 段落基方向，并从正确边缘绘制阿拉伯/希伯来段落；CJK、Emoji 与显式换行继续使用受限字素簇换行。此决定不表示已实现 HarfBuzz/ICU4X/FreeType 塑形、完整 Unicode 断行、富文本 run、Glyph Atlas、可移植字体加载、跨平台文本测量、可编辑 Caret/Selection 或 IME 协调；Canvas 的浏览器塑形与 bidi 行为不是最终 Text Engine 的兼容承诺。
