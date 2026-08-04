# ADR 0015：Canonical Paint、DocumentColorProfile 与 Snapshot v9

状态：已采纳（Phase 0.9 基础）

## 决定

- `Node.fill` 与 `Appearance.fill` 使用 Rust `Color` 保存显式色彩空间、非预乘 RGB 分量和 alpha，不再把 CSS 字符串作为 Canonical 文档值。
- Document 使用 Canonical `DocumentColorProfile` 声明默认颜色解释，当前支持 `sRGB` 与 `Display P3`。它通过 Transaction 变更、参与 Operation payload hash、Canonical hash 和 Undo/Redo；切换配置不重解释已有的显式 `Color`，而是为后续 profile-aware asset 建立稳定默认值。
- `Paint` 当前支持 `Solid(Color)` 与 `LinearGradient`。线性渐变使用节点局部归一化起止点、2–16 个按位置非递减的 stop，并逐 stop 保存显式 `Color`。非法坐标、退化向量、无序/越界 stop 与无效颜色在 Reducer 修改前拒绝。
- Canonical Hash 与 Operation payload hash 编码色彩空间、各通道和 alpha；因此相同数值但不同色域不会被视为同一文档状态。
- WASM Snapshot schema v9 同时保存 `colorProfile`、`fillColor`、`fillGradient`、`strokeColor`、`strokeGradient`（Canonical gradient stop）、`rotation`、`stroke`、`strokeWidth` 和 CSS 显示回退。旧 v1–v6 Snapshot 缺少渐变时迁移为 Solid；v7 缺少 Canonical rotation、v8 缺少 Canonical stroke Paint 时由本地旧 presentation sidecar 迁移。只有 v9 hash 编码所有当前 Canonical 字段，因此从 v9 开始校验持久化 Canonical hash。
- UI 的 CSS 输入桥只接受 `#rgb`、`#rgba`、`#rrggbb` 与 `#rrggbbaa`。对已有的广色域 `fillColor` 做无关属性更新时必须原样传回，不能因再次序列化而丢失色域。Canvas/CSS 预览会按与 Core 相同的线性 D65 P3→sRGB 矩阵生成确定性回退，绝不把 P3 编码分量误当作 sRGB。
- Canvas 2D 的 `CanvasGradient` 原生在编码色值间插值，因此 Worker 在每一个 Canonical stop 区间发出 64 个线性 sRGB 样本（最多 961 个 Canvas stop），并保留原始 stop 位置与合法的同位置 hard stop。它是有界的 Canvas 2D 近似；最终 GPU、导出和 HDR 流水线仍须直接使用线性预乘色值。

## 后果

Solid Color、文档默认色彩配置与基础 LinearGradient 已可确定性存储、回放和迁移；Canvas 2D 将渐变投影为本地坐标 `CanvasGradient`，并以受限线性 sRGB 样本近似显示。Inspector 可编辑方向、stop 颜色/位置，并在 2–16 个 stop 范围内新增或删除。当前不含径向/角向/网格渐变、Canvas 2D 广色域保证、图片 ICC、GPU/导出色彩管理或 HDR。
