# Phase 2 预检记录

- 日期：2026-08-06
- 状态：进行中，**不是 Phase 2 完成声明**。

## 已通过的自动验证

- 完整 Ellipse 的 Center/Outside Stroke Align：真实浏览器 Fixture 新建 Ellipse 后切换 Outside，Inspector 保持该值、Canvas 渲染成功且 console 0 error；Donut Arc 不展示 Stroke Align。Core/WASM 已重建，避免旧二进制拒绝合法 Canonical 属性。
- Arc 状态迁移：Fixture 的 `Outside Ellipse` 将 End 从 `360` 改为 `180` 后，浏览器以单一更新创建 Arc 并自动回到 Inside；Stroke Align 控件随 Arc 隐藏，console 0 error。
- Closed-shape Visual Bounds：Outside Ellipse 的外描边已通过浏览器 Fixture 验证被选中框完整覆盖；完整 Ellipse、Frame 与 Rectangle 的 Center/Outside Stroke 均以同一视觉包围盒用于 Canvas culling、选中/悬停框、Resize 手柄、框选/多选与 SVG viewBox，Frame/Rectangle 的 Top/Right/Bottom/Left Weight 会按当前对齐逐侧外扩。统一描边的独立圆角会在精确 Hit Test 中同步外扩。单测覆盖统一与四边独立 Weight、独立圆角，console 0 error。
- 浏览器复核：Fixture 中的 `Asymmetric Card`（Outside、四边独立 Weight、四角独立 Radius）选中后，外扩的选框和八个 Resize 手柄均与可见 Stroke 包围盒对齐；截图保存在 `output/playwright/phase2-closed-shape-selection.png`，console 0 error。
- Image-filled Ellipse Stroke：Canvas 与 SVG 现在复用同一份 Inside/Outside 环形几何；单测覆盖环形尺寸和极粗 Stroke 退化，生产构建通过。真实 Asset API 环境已通过同源 `/asset-api` 代理重放：在 Fixture 的 `Outside Ellipse` 上传图片后，上传分片、完成、文档绑定、下载授权与图片读取均返回成功；图片填充可见，依次切换 Inside/Center/Outside 后无浏览器错误。
- Image-filled Frame Stroke：在同一真实 Asset API 路径为 `Root Frame` 绑定图片后，取消 Corner Smoothing 并切换为 Outside；图片裁剪结束后绘制的 Rust/WASM 圆角网格没有被遮罩裁掉，Inspector 保持 Outside、选中框完整覆盖可视描边且 browser console 为 0 error。该回归同时修复了“资源 ID 未改变时的完整节点更新”被错误判为非法资源引用的问题；截图为 `output/playwright/phase2-image-filled-frame-outside-mesh.png`。
- WebGPU Closed-shape Stroke：完整 Ellipse、以及 uniform Stroke/圆角的 Frame/Rectangle 的 Center/Outside 不再因描边对齐被整体送回 Canvas；Rust 预计算实例和 GPU 都以扩展 Quad 与环形模型绘制。Arc/Donut、图片填充、四边 Weight、独立圆角与 Corner Smoothing 仍明确走 Canvas。投影及 GPU 前缀单测覆盖该分流，生产构建通过。

- `cargo test -p editor-core -p editor-wasm -p makefigma-document-codec -p makefigma-document-service`
  - Core：75 项；WASM：35 项；Document Codec：1 项；Document Service：8 项。
- `cargo test -p makefigma-renderer-wgpu`
  - Rust GPU 实例批次：6 项。
- `pnpm test`
  - 125 个测试文件、434 项测试。
- `pnpm build`
  - Next.js 生产构建通过。
- `pnpm protocol:check`
  - Protobuf 生成类型与 TypeScript 校验通过。
- `pnpm check:compatibility`
  - Phase 1 兼容矩阵检查通过。
- `pnpm check:phase2-common-nodes-fixture`
  - 固定 Phase 2 常见节点 Fixture 的 SHA-256、层级和专项几何字段通过。
- 2026-08-06 当前源码复审
  - Fixture 检查、432 项前端测试与 Core/WASM（72/35）测试均通过；`pnpm check:boundaries` 仍只因既有 Next Route Handler 失败，详见下方 Gate。当前源码在本次 Stroke 改动后尚未重新进行 60 分钟冻结采集。
- Fixture 现新增 `Outside Ellipse`，固定覆盖完整 Ellipse 的非 Inside Stroke Align；因此旧 Fixture 的本地 Golden/性能候选必须重新采集，不能继续作为本版本的证据。
- `pnpm mock:backend:check`
  - 独立 Mock Backend 在临时端口验证通过。
- 本地编辑器：`http://localhost:3013/` 返回 HTTP 200。

## 当前已知 Gate 失败

`pnpm check:boundaries` 失败，原因是现有的
`src/app/api/workspaces/[workspaceKey]/route.ts` 使用了 Next Route Handler；
边界规则要求业务 API 位于独立后端。该文件不是本轮 Phase 2 修改的目标，
因此本记录只保留失败证据，不以放宽规则的方式掩盖它。

## 本轮覆盖的 Phase 2 证据

- 多选 Inspector 的 X/Y/W/H 与 Canvas 八手柄使用同一 world visual bounds；编辑任一字段会在一笔 Core Transaction 内平移或缩放完整选择集，旋转/Relative-v1 图层按 parent-local 矩阵回写，Group 会递归展开其可编辑子树，Line 取真实 Stroke/Cap Bounds。
- 浏览器 fixture 已验证 Layer Panel 的 Shift 点击 `Asymmetric Card` 与 `Donut Ellipse` 会保持两个节点的 selection，并立即显示 Mixed Inspector 的 X/Y/W/H；0 条 browser console error。

- `F-PHASE2-COMMON-NODES` 固定 Fixture 可通过 `?fixture=phase2-common-nodes`
  直接打开，覆盖嵌套旋转 Frame、Group、Rectangle、Ellipse Arc/Donut、独立端点
  Cap 的 Arrow、Section 和 Text；单测会验证层级、Line 几何及世界变换，并将全部节点
  作为 Create 批次编码、解码为真实 Protobuf `ResolvedOperationBatch`，核对节点种类、父子关系、
  几何、四角圆角、Stroke、Arc、Line 端点、Section 内容可见性与 Text 内容。该验证覆盖浏览器
  的 Canonical→Operation 保存边界。Rust/WASM 回归还将同一完整节点层级经过共享 Protobuf Snapshot 与本地 JSON Snapshot 两次恢复，并核对 Canonical Hash 完全一致，覆盖服务恢复 Hash Gate。

- Line 选中/悬停框围绕实际 Stroke 与端点可视边界，旋转后保持居中。渲染 culling、悬停与选中覆盖层以稳定 NodeId 而非两次投影产生的对象引用关联，因此 Relative-v1 子树中的 Line 会稳定显示 Figma 式细选中框、端点控制点与零高尺寸标签。
- 浏览器复核：在固定 Fixture 的 `Independent-cap Arrow` 图层选择 Line 后，选框紧贴带 Square 起点与 ArrowLines 终点的实际可视路径，显示两个端点控制点和 `286 × 0` 的 Line 几何标签；该次复核记录 0 条浏览器 console error。
- Line 的起止端点可在拖拽时穿越彼此：Legacy 与 Relative-v1 均翻转局部方向、保持未拖动端不动，并保留 Start/End 样式的端点语义；180° 三角函数尾差按现有仿射容差验证。
- 实线 Line 可独立组合两端的 Round/Square/Butt Cap；对称 Butt/Round/Square 的虚线 Line 现由 Rust Core 分割可见 dash 并以 WASM Mesh 绘制，选中框与精确 Hit Test 仅在实际画到首尾端点时外扩 Cap，避免末尾 Gap 产生虚假高亮或可点击范围。虚线非对称 Cap 在 Canvas 与 SVG 均明确降级为 Butt，避免错误复用一侧样式到每一段 dash；选框与精确 Hit Test 同步移除不存在的圆/方端点延伸。
- Dash Tessellation 会以 16,384 个分段为资源上限；极小的异常 Dash 值会被 Core 以 `ResourceLimit` 拒绝，不会无界占用渲染或导出资源。
- Rust Stroke Mesh 经 WASM 暴露；普通 Line 与无 Corner Smoothing、统一宽度的直角/统一圆角/独立圆角 Frame/Rectangle
  在 Canvas 消费同源网格，并覆盖 Inside/Center/Outside 对齐；同类图片填充会在裁剪后复用该网格，避免 Outside 被图片遮罩裁掉。Corner Smoothing 使用与 Canvas 相同的连续超椭圆采样进入 Core/WASM Mesh，因此 Dash 不会退化为实线；直角、无平滑角的四边独立 Weight 同样由 Core 计算 Top/Right/Bottom/Left 的对齐中心线，再按固定绘制顺序消费四条 Rust/WASM 开路径 Mesh；设置 Dash 时保持现有“每条独立边从零相位开始”的明确语义。圆角或平滑角的四边独立 Weight 继续保留可靠 Canvas 降级。
- 直角、统一 Weight 的 Frame/Rectangle 现也可从 Stroke details 的 Dash 输入进入 Core/WASM 闭合 polyline tessellation；连续可见 Dash 跨越角点时保留 Join，Gap 会生成独立 Cap。统一或独立圆角、以及 Corner Smoothing 的连续超椭圆采样都共享 Core 的中心线与虚线 tessellation，避免 Inside/Outside Dash 被环形填充退化为实线。
- 浏览器复核：将 Fixture 的 `Asymmetric Card` 临时切换为四角 `0`、Corner Smoothing `0%`、Dash `18, 8` 后，四边独立 Weight 的 Rectangle 走 Rust/WASM 网格，画布可见虚线、Inspector 保持属性且 browser console 为 0 error；截图为 `output/playwright/phase2-per-side-dash-core-mesh.png`。该节点恢复独立圆角或平滑角时会按兼容边界回退 Canvas。
- 浏览器复核：Fixture 的 `Root Frame` 保留其 TL/TR/BR/BL 独立圆角，临时移除 Corner Smoothing 并设为 Dash `18, 8` 后，圆角虚线由 Rust/WASM 网格绘制；Inspector 与画面均保持该值，截图为 `output/playwright/phase2-rounded-dash-core-mesh.png`。
- 浏览器复核：Fixture 的 `Root Frame` 保留其原始 `25%` Corner Smoothing 并设为 Dash `18, 8` 后，连续角虚线由 Rust/WASM 网格绘制，Inspector 保持 Dash、browser console 为 0 error；截图为 `output/playwright/phase2-continuous-corner-dash-core-mesh.png`。
- SVG 支持 Solid Alpha、Stroke Align、四边独立 Stroke Weight；Frame/Rectangle 的统一粗细 Inside/Outside 虚线会导出为对齐后的虚线中心线路径，不会退化成实线 Paint Ring；Line 的实线非对称 Round/Square Cap 与 Canvas 共用填充轮廓模型，且 viewBox 复用
  含 Stroke、Cap 与端点装饰的可视 Bounds；对称 Cap 的虚线末尾若为 Gap，viewBox 同样不会凭空延伸末端 Cap。实线的不同起止 Round/Square Cap 使用单一填充轮廓导出，并对图片资源保留向量 fallback 提示。
- 四边独立 Weight 的 SVG 虚线同样按 Top/Right/Bottom/Left 分边输出：每边保留其自身宽度、对齐中心线、Butt 角端和零相位 Dash 周期；Inside 会复用 Shape Clip，不会把描边画到边界外。
- 四边独立 Stroke 的 Inside 对齐会按各边自身宽度向内偏移半个 Weight，因此实际画面不再被边界 Clip 削掉一半；Canvas 和 SVG 共用同一位置计算。
- SVG 的 Frame/Rectangle/Section Shape 与 Frame Clip 会使用和 Canvas 一致的连续 Corner Smoothing 超椭圆近似，不会在导出时退化为普通圆弧。
- Mixed Inspector 以单一 Core Transaction 批量修改适用属性；复杂 Paint Stack
  不会在多选时被隐式扁平化；全可绘制节点选择可批量编辑 Join、Miter limit 与 Dash Pattern，Start/End Cap 则严格只对全 Line 选择显示；全 Frame/Rectangle 选择可逐侧批量编辑 Stroke Weight；全 Frame/Rectangle/Section 选择可逐角编辑 Radius 与 Corner Smoothing；排除 Group/Section 的多选可逐轴编辑 Constraints，保留未修改轴的每节点值，并可移除显式约束恢复 Legacy 无约束语义。
- Stroke Align/Weight 的 Inspector 能力边界现有独立单测：Frame、Rectangle、完整 Ellipse 可显示 Align；Arc/Donut、Section 与非闭合节点不可显示；仅 Frame/Rectangle 可显示四边 Weight。单选和多选共用同一判定，避免控件与渲染能力分叉。
- Mixed Inspector 的 `fill`、`stroke width`、`stroke align`、四边 Weight、四角 Radius、Line Stroke、Frame Clip 和 Section Hide contents 已收敛到同一能力矩阵；矩阵测试覆盖空选择、Frame+Rectangle、全 Line、Group+Section 与完整 Ellipse+Arc 的 NotApplicable 边界。真实 Fixture 再次验证 Frame+Rectangle 多选显示 Mixed Stroke/Weight/Radius 控件，Group+Section 多选则只保留 Geometry、通用 Selection 与可访问的 NotApplicable 说明，browser console 0 error。
- 能力矩阵单测现逐项列出 Frame、Rectangle、Ellipse、Line、Section、Image、Text、Group 的完整单选结果，并验证 Frame+Text、Rectangle+Line、Section+Image 等异构组合只保留所有节点都可安全写入的字段。
- 浏览器复核：Fixture 的 `Asymmetric Card` + `Root Frame` 多选会显示可访问的 `Stroke details`；将 Join 改为 Round、Dash 改为 `18, 8` 后两节点以同一 revision 更新，Inspector 保持新值且 browser console 为 0 error。截图为 `output/playwright/phase2-mixed-closed-stroke-details.png`。
- Constraints Inspector 只对 Frame 直接 child 或仅经 Group 嵌套的后代开放；根级、Section 子树和不完整/循环祖先链会明确排除，防止不可生效的属性写入。
- Inspector 的单选和多选共享 NotApplicable 边界：Group 只作为结构容器显示几何和图层属性，绝不暴露 Fill、Stroke、Paint Stack 或圆角编辑；Line 仍可编辑 Stroke Stack，但不显示闭合节点圆角。浏览器 fixture 已复核 Group 选中后的控件边界。
- Text 的单选 Inspector 提供基础 Fill、Linear Gradient 和 Opacity，不错误暴露 Stroke/Paint Stack；渐变 Text 会从实色 GPU Glyph Atlas 显式回退 Canvas。浏览器 fixture 已修改 `Fixture label` Fill 并 Undo，Canonical hash 回到初始 `6df7de5f2765`，且 0 条浏览器 console error。
- SVG Text 导出已保留换行、对齐、行高与段落间距；混合 Style Run 会按 UTF-8 字节范围输出 `tspan`，保留每段字号、字重、斜体与字距。复杂逐 run shaping、精确字距定位与 RTL/BiDi 排版仍作为明确 Partial 边界保留。
- Group 的透明 derived bounds 不会截获 child 命中：浏览器已验证先选择 `Asymmetric Card`、再 Shift 点击 `Donut Ellipse` 会形成两个可绘制节点的选择，而不是把 Ellipse 替换为 `Content Group`；Group 的空白 bounds 和图层行仍可选择。
- Group 拖拽会仅平移被选 Group；其 Relative-v1 子树继承同一变换，旧 world-space 子项才会显式跟随移动。Core 回归覆盖两个并列 Group：移动第一个后第二个 Group 与其 child 的 world 坐标保持不变，避免多个 Group 之间的边界重算串扰。
- Golden 与性能候选采集：`pnpm evidence:phase2-common-nodes` 已在本地固定 `1440×960`、DPR `1`、WebGPU 环境重新采集当前源码的 `F-PHASE2-COMMON-NODES`；当前截图 SHA-256 为 `9100fe8f21407c34c07f4b8f68606b13a94a9ee3cbb71ce6fcddfbdeb9662cd4`，并记录 0 条浏览器 console error、Fixture/manifest hash 与环境元数据。采集器还以三轮、每轮 64 个交替 Pan 输入记录真实 `input→render`：中位 Render P95 `1.015ms`、Input-to-render P95 `19ms`、输入队列 P95 `17.785ms`，均低于本地阈值（`12ms/50ms/32ms`）。候选位于 `output/phase2-common-nodes/20260806T041922Z/`，Golden 与性能均仍是 `local-candidate` / `pending-independent-review`，不替代独立审核或 60 分钟稳定性。
- 60 分钟稳定性采集：首轮候选 `output/phase2-common-nodes/stability-20260806T004408Z/` 虽已跑满 3,600 秒并产生结束截图，但本轮源码热更新触发一次 Next.js HMR WebSocket `Invalid frame header` console error；采集器按规则退出，**该候选无效，不得计入 Gate**。源码冻结后的重跑 `output/phase2-common-nodes/stability-20260806T014459Z/` 已成功完成 3,600 秒、183 轮（每轮 64 个交替 Pan），包含起止截图、环境与哈希元数据，浏览器 console 为 `Errors: 0, Warnings: 0`；中位 Render P95 `1.01ms`、Input-to-render P95 `19ms`、输入队列 P95 `16.99ms`，均通过本地阈值（`12ms/50ms/32ms`）。该结果仍为 `local-candidate`，不能替代独立审核。
- 图层面板支持方向键导航、Tab/Shift+Tab 层级移动和 F2 重命名；Group/Ungroup 也在左侧 Selection actions 可见，分别绑定 `⌘/Ctrl+G` 与 `⇧⌘/Ctrl+G`。
- 图层面板可展开/收起 Frame、Group、Section；收起容器会从虚拟化列表、键盘导航和焦点顺序中移除完整 descendant 子树，并通过 `aria-expanded` 暴露当前状态。层级行的 `←/→` 可收起、展开、回到父级或进入首个子级。
- Layer Panel 保持父级行位于其所有子项之前，并仅对同级节点按前后层级排序；这修复了 Frame / Selection 等子节点显示在父级标题上方的问题。
- 绘图工具可由快捷键选择，并以 Enter 在当前视口中心创建对应默认节点；Arrow
  保持为 Line + ArrowLines 的 Canonical 映射。
- Canvas Transform 支持单选和多选的八方向 Resize、Shift 锁比例、Alt/Option 中心缩放；矩阵节点以局部/世界仿射换算保持视觉稳定，Line 可编辑两个端点。多选会以一笔 Core Batch 提交；Frame/Section 的真实几何 Resize 保留 Core constraints 传播，Group 会递归覆盖 Frame/Section 子树、按父级在前提交，并由 child 更新重新派生 Bounds。
- 所有常见节点的单选无修饰键 Resize 可越过对侧锚点；实现以正的宽高和 Relative-v1 反射矩阵表达镜像。浏览器中已用旋转嵌套 Frame 内的 `Asymmetric Card` 验证横向穿越（W 180→73、Rotation 0°→180°），并验证了旋转嵌套 `Rotated Frame` 与 `Section`：child 子树仍随父变换镜像、Frame Clip 仍生效。三种场景 Undo 后 Canonical hash 恢复、无控制台错误。
- 多选无修饰键 Resize 同样可跨越对侧锚点：Legacy 节点保持正 Geometry，仿射节点（含 Group 子树）以 world selection reflection 回投到 parent-local 矩阵。浏览器已验证包含 `Content Group` 与其 selected descendant 的组合选择可镜像、可 Undo，且恢复初始 Canonical hash、无控制台错误。
- 嵌套 Clip Frame 在裁剪路径建立后将 Canvas 变换复位；子节点现在与其选中框在同一 world 变换下绘制，不会重复叠加父 Frame 变换。
- Core 回投影中 Group 的 `cornerSmoothing: 0` 会作为“不适用、未设置”编码，而非非法属性；该修复避免 Group 或其子节点的变换/回放在远端 Operation 序列化时产生引擎错误。
- Section 的 Hide contents 会在渲染 culling、Canvas 绘制与命中中一致抑制完整 descendant 子树，而 Section 本身仍保持可见；纯 Frame / 纯 Section 多选可分别批量修改 Clip content / Hide contents。

## 仍未通过的 Phase 2 完成条件

| Gate | 现有证据 | 结论与下一步 |
| --- | --- | --- |
| 完整同源 Stroke Geometry | Line、直角/圆角/独立圆角/Corner Smoothing 的统一 Weight Frame/Rectangle、以及直角四边 Weight 的 Rust/WASM Mesh 均已有专项验证；完整 Ellipse 的环形实例和 SVG 对齐描边也有覆盖。 | **未完成**：圆角或 Corner Smoothing 的四边 Weight、图片与所有导出目标尚未由同一 Rust Outline/Tessellation 完全驱动。 |
| Mixed Inspector 能力矩阵 | 通用 Geometry、Opacity、Visible、Lock、全 Line Stroke、Frame/Rectangle 边 Stroke、Ellipse Stroke Align、Constraints 和 Paint Stack 的主要路径均有实现与 Fixture 证据。 | **未完成**：需要对每种多选组合形成完整的 NotApplicable 可访问性矩阵及端到端验收。 |
| Golden 与性能 | 短时本地候选与源码冻结的 60 分钟候选（183 轮、console 0 error、Render P95 `1.01ms`、Input-to-render P95 `19ms`、输入队列 P95 `16.99ms`）均已固定 Fixture/manifest 哈希、截图、环境和性能记录。 | **未完成**：采集后已继续改进统一 Rectangle/Frame Stroke 网格，因此最终源码冻结后必须重跑 60 分钟采集；结果仍需由独立审核者冻结 Golden/性能候选。 |
| 前端独立部署边界 | `pnpm check:boundaries` 已通过（258 个前端源文件）；工作区目录服务已迁入独立的 `services/workspace-api/`，前端仅经同源代理调用。 | 已完成候选；保持现有边界规则，最终冻结源码时随其余 R0 检查复跑。 |
