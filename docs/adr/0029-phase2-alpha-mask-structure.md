# ADR 0029：Phase 2 通用蒙版采用同级后续层的 Alpha 结构

状态：已采纳（Phase 2 G4，首个可用切片）

## 背景

Frame 的 `clipsContent` 只能裁剪子树，不能表达旋转形状、半透明形状或图片对相邻图层的遮罩。把派生像素、临时位图或一份重复的 target 列表写入 Canonical Document 会同时破坏可编辑性、Undo/Redo 和远端重放的一致性。

## 决定

- Phase 2 的唯一通用模式是 **alpha mask**。不实现 luminance、反相、混合模式或持久化的 raster cache；这些能力留给 Effect Stack。
- 一个可绘制、非 `Group` / `Section` 的节点启用蒙版后，作为其同一 Page、同一 parent、按 Canonical `PositionId` 排序的后续同级节点的 alpha 源；作用范围在下一个蒙版同级节点前结束。蒙版本身不作为普通可见层绘制。
- `SetMask { id, enabled }` 是专用 Canonical Command。启用时必须存在后续同级节点；禁用时只移除该标记，不改变节点 ID、位置、parent、世界变换或任一被遮罩节点。
- 标记存入保留扩展键 `makefigma.mask.alpha.v1 = [1]`。扩展字段本身已进入 Snapshot、Hash 与前后兼容 round-trip；这样不改变既有 `SceneNode` wire shape，同时仍是确定性的 Canonical 状态。未知客户端按 ADR 0023 保留该键。
- Canvas 在一个与已准入渲染表面等大的临时 surface 中先画目标 sibling run，再以 `destination-in` 应用源 alpha；SVG 用 `mask-type="alpha"` 和相同世界变换输出。每个临时 surface 上限为 128 MiB，最多两层嵌套；超过任一预算时目标 run 失败关闭并记录诊断。WebGPU 对含蒙版的页回退 Canvas，直到 Render Graph 增加有预算的 mask pass。
- 命中测试沿 parent 链检查 Frame Clip，并在每一同级层检查最近的前置蒙版；pointer 不在蒙版可见几何内时，被遮罩目标不得被普通点击命中。

## 后果

- Core、WASM batch、Protobuf Operation、Document Service、Undo/Redo 与远端重放可独立验证标记的确定性，不依赖浏览器的 sibling 顺序推断。
- 首个切片覆盖实色与透明形状、旋转 affine 投影、Frame Clip 和 SVG。图片源、PDF、像素 Golden、离屏 surface 池、明确的嵌套深度预算与设计师验收仍是 G4 的后续 Gate，不能因此标记为完整支持。
