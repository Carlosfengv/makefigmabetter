# ADR 0031：Phase 2 Effect Stack 采用有界、有序的 Canonical 效果列表

状态：已采纳（Phase 2 E1，分切片实施）

## 背景

R3 已有单一 `DropShadow` 字段，且它已经进入 Canonical Hash、历史、Protobuf、Snapshot、Canvas 和 SVG。然而单字段无法表达多重阴影、Inner Shadow、Blur、Blend Mode 的顺序，也无法为 Canvas、WebGPU 和导出建立同一个预算契约。

## 决定

- 每个可绘制节点最终拥有按数组顺序合成的 `EffectStack`；节点的 `blendMode` 独立于 Effect Stack，并在将该节点结果与底图合成时应用。
- Blend Mode 的首个可交付枚举固定为 `normal`、`multiply`、`screen`、`overlay`、`darken`、`lighten`，默认 `normal`；它必须以独立 Canonical 字段进入 Node、Appearance、Snapshot、Operation 和 WASM 投影。Canvas 以等值 `globalCompositeOperation` 合成；SVG 仅对可表达模式输出 `mix-blend-mode`，其余路径必须进入兼容性报告。
- `Effect` 的 Phase 2 变体固定为 `DropShadow`、`InnerShadow`、`LayerBlur`、`BackgroundBlur`。每个变体均有 `visible` 字段；Shadow 使用 offset、blur、spread、color，Blur 使用 radius。
- 单节点最多 8 个 Effect，Blur 半径为 `0..=256`，Shadow offset/spread 为 `-10,000..=10,000`，所有数值必须为有限值。非法值在 Core 事务边界拒绝；预算拒绝不得改变 Document。
- 合成顺序为：先绘制节点本体与直接子内容到局部隔离表面，按数组顺序应用 Effect，再以 `blendMode` 合成到父表面。`BackgroundBlur` 读取同级先前已经合成的 backdrop；遇到 Frame Clip/Mask 时仍受该 Clip/Mask 限制。
- R3 的 `drop_shadow` 是过渡兼容字段：读取旧 Snapshot 时投影为一个等值、可见的 `DropShadow` Effect；新 Snapshot 在完整迁移切片完成前同时写入旧字段与等值的首个 Stack 条目。若两者冲突，Stack 是唯一语义来源，但必须保留诊断并禁止静默覆盖。
- 旧客户端无法理解 Stack 时必须保留未知 extension bytes，且不可将已知 R3 shadow 清空。Effect 的运行时离屏表面、GPU handle、缓存键和诊断均为派生状态，禁止写入 Document/Snapshot。
- 初始浏览器预算：每个 effect surface 128 MiB、每帧 effect surface 总计 256 MiB、嵌套深度最多 2。WebGPU Device Lost 时丢弃所有派生 surfaces，并从最新不可变投影重建；第二次失效沿现有策略稳定回退 Canvas。

## 分切片交付

1. 先保留 R3 单一 Drop Shadow，Canvas 与 SVG filter 对齐，作为无损迁移基线；在没有 morphology pass 的这一步，正 spread 与 Canvas 一样并入 blur kernel，负 spread 不产生额外视觉扩张。
2. 加入 Stack 的 Schema/Core/Codec/Service/WASM 往返与 migration Fixture；旧字段继续镜像首个 Drop Shadow。
3. 扩展 Canvas 隔离 surface 与有界池，启用最多 8 个有序 Drop Shadow；再依序启用 Layer Blur、Inner Shadow、Background Blur 和 Blend Mode。
4. WebGPU Render Graph/纹理池与 PDF/SVG 降级必须明确报告；任何不支持变体不得静默丢失。

## 后果

- 任何 E1 后续切片都不能直接向 Canvas-only 状态字段添加效果；必须先通过 Canonical Stack 及预算验证。
- R3 的基础阴影不会因升级而改变 Canonical Hash 以外的视觉意图，且旧 Snapshot 保持可读。
- E1 在所有变体、隔离池、导出与 Golden 完成前维持 `Partial`，不得因单一 Shadow 支持而标记完成。
