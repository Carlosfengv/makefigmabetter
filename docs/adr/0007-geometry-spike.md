# ADR 0007：Phase 0 几何数值与命中测试基线

状态：已采纳（Phase 0 Spike）

## 决定

- Canonical 几何基础以有限 `f64` 表示；`Point` 的构造拒绝 NaN/Infinity 并归一化 `-0`，不依赖显示格式化来确定文档数值。
- 变换使用 Canvas 兼容的 2×3 仿射矩阵。组合、逆变换与局部空间命中均从该模型推导；接近奇异的矩阵显式拒绝。
- Core 提供 Line、Quadratic、Cubic Bézier 的 De Casteljau 求值与有界递归展平、展平边界、Even-Odd/Non-Zero 填充命中、Polyline 描边命中，以及确定性的轴对齐矩形 Union / Intersect / Subtract 基线。
- Canvas 2D 投影在命中前先把世界坐标逆变换到节点局部空间，精确区分旋转矩形、圆角矩形和椭圆；层级顺序、隐藏与锁定仍在候选筛选阶段处理。
- Phase 0 的 Frame 与 Rectangle 将 Canonical bounds 定义为外轮廓，并统一采用 `inside` stroke：半径夹紧到当前短边的一半，描边宽度也夹紧到可用内部空间；内轮廓以 `max(outerRadius - strokeWidth, 0)` 计算。Canvas 2D 与 WebGPU 必须消费这组相同的屏幕像素几何，尺寸缩小时不得产生负内部尺寸或让描边越出节点 bounds。
- Phase 0 的画布操作以 1 个世界像素为默认网格吸附单位：创建、拖动与绘制尺寸均吸附到该单位；Inspector 的 X/Y 直接输入保持 Canonical 小数值，不参与吸附。网格不是低缩放背景：仅在超过 400% 时，以至少 4 个屏幕像素的间隔覆盖在场景与选中态之上；此时可见每个 1px 网格线。选中框直接贴合节点的外部 bounds，不额外外扩间距。
- Phase 0 的画布缩放范围为 2%–25,600%，与 Figma 的缩放边界保持一致；缩放必须继续以光标锚点维持世界坐标，不为高倍率引入第二套视图坐标。

## 迁移边界

当前 Schema 还没有任意 Path、Stroke Join/Cap/Dash、Clip、Mask、R-tree/BVH 或文本 Glyph 轮廓。Worker 已采用可重建 fixed grid 为空间候选查询和视口裁剪加速，但它不是生产级 R-tree/BVH，也不提供 Path、Mask 或 Glyph 精确命中。因此任意路径布尔运算、真实描边 outline、深层选择与生产级空间索引尚未声明完成；矩形布尔仅作为可重复的 Phase 0 数值基线。

## 后果

后续 Path Schema、Renderer 和导入器必须复用 Core 中的有限数值/局部空间原则，并为近共线、相切、自交、退化段和超大坐标加入 Golden fixture。若引入专用 Boolean/Stroke 库，也必须先用这些 Fixture 证明稳定输出，不能以库默认容差替代明确策略。
