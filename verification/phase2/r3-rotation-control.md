# Phase 2 R3 验收记录：旋转、键盘位移与基础 Shadow（候选切片）

- 日期：2026-08-09
- 状态：自动与真实浏览器候选通过；**R3 仍在实施中**。
- 覆盖源码：`src/lib/selection-rotation.ts`、`src/lib/selection-nudge.ts`、`src/workers/editor.worker.ts`、`crates/editor-core/src/lib.rs`、`crates/editor-wasm/src/lib.rs`、`src/components/editor/editor-shell.tsx`。

## 已验证

1. 单选和多选的选择框均渲染独立旋转控制柄；拖拽以选择范围中心为 pivot。
2. 旋转从手势开始时的不可变 Canonical 快照计算；Shift 按 15° 吸附。父级旋转会保持 Relative-v1 子节点的相对矩阵，并仅转换仍为世界坐标的 Legacy 子节点。
3. 真实浏览器固定 `phase2-common-nodes` Fixture：选择 `Asymmetric Card` 后，从控制柄拖拽得到 `72°`；Undo 回到初始 Canonical Hash `abb6d3c90906`，Redo 恢复 Hash `ee2ca9e23e15` 和 `72°`。控制台 `0` error。候选产物：
   - `output/playwright/phase2-rotation-before.png`
   - `output/playwright/phase2-rotation-after.png`
   - `output/playwright/phase2-rotation-redo.png`
4. 方向键可将当前选择按世界坐标移动 1px，`Shift`+方向键移动 10px；它与 Pointer drag 共用 Relative-v1 世界到父级局部矩阵换算，且在 Layers 虚拟列表拥有焦点时让出箭头键给 roving focus。一次按键通过单一 Core 事务提交全部受影响节点。
5. 真实浏览器固定 `phase2-common-nodes` Fixture：选中 `Asymmetric Card` 后，Layers 内的 `ArrowRight` 保持 roving focus；将焦点移至 Move 工具后，`ArrowRight` 与 `Shift+ArrowDown` 各形成一笔 Canonical 修订，Hash 从 `abb6d3c90906` 变为 `dec11c0b3fec`、`585aee7b03b4`。两次 Undo 精确恢复 `abb6d3c90906`，两次 Redo 恢复 `585aee7b03b4`；console 0 error。候选截图：`output/playwright/phase2-keyboard-nudge.png`。
6. 基础 Drop Shadow 作为可选 Canonical 字段持久化 `offsetX`、`offsetY`、`blurRadius`、`spread`、颜色与可见性；Core 校验有限数值/预算范围，Group 不接受 Shadow，Canonical Hash、Undo/Redo、WASM JSON Snapshot、Protobuf Snapshot 与服务操作适配器均已覆盖。Canvas 2D 使用同一字段渲染；WebGPU 遇到可见 Shadow 时明确回退 Canvas。SVG 当前保留文档字段并返回降级报告，等待 E1 的 filter/effect-stack 管线。
7. 真实浏览器固定 `phase2-common-nodes` Fixture：选择 `Asymmetric Card` 并在 Inspector 启用 Shadow 后，控件回显 X/Y/Blur/Spread/颜色/Opacity（默认 `0/4/12/0/#000/25%`），Hash 从 `abb6d3c90906` 变为 `965bf62eb5d9`；Undo 恢复前者，Redo 恢复后者，控制台 0 error。候选截图：`output/playwright/phase2-drop-shadow.png`。
8. 图层键盘改名的焦点恢复：真实浏览器固定 `phase2-common-nodes` Fixture 中，选择 `Fixture label` 后按 F2、输入新名称并按 Enter，焦点回到已改名的图层行；再次 F2 后输入草稿并按 Esc，草稿被取消且焦点仍在原行。随后 ⌘Z/⌘⇧Z 恢复/重做名称时焦点继续留在该行，控制台 `0 error`。固定 Fixture 不再把这类本地证据编辑写入共享 Workspace catalogue，因此不会产生无关 409。
9. 工具栏焦点不会再吞掉键盘创建：真实浏览器固定 `phase2-common-nodes` Fixture 中，先点击 `Move (V)` 令工具栏持有焦点，再按 `R` 和 Enter；Canonical Hash 从 `53365ce0465a` 变为 `093d11e80444`，证明 Rectangle 已由 Worker 创建而非重新触发旧的工具栏按钮。随后 Reset demo 恢复固定样例，浏览器控制台 `0 error`。
10. 真实图层排序回归：固定 `phase2-professional-composite` Fixture 中，将 `Blur and blend card` 拖至 `Masked texture target`，Canonical Hash 从 `64d0d2307c85` 变为 `091732d52c5d`；浏览器控制台 `0 error`。Reset demo 后固定样例恢复。
11. Mixed Inspector 无障碍采集：真实浏览器固定 `phase2-common-nodes` Fixture 中，选择 Frame 与 Text 后，`role=status` / `aria-live=polite` 的播报逐项包含 `2 layers selected`、可编辑的 Drop shadow、Mixed Fill 和 NotApplicable 能力；控制台 `0 error`。证据位于 `/tmp/makefigma-phase2-a11y-r3-20260810/`，其中元数据仍标为 `pending-independent-review`，不能替代桌面屏幕阅读器的独立验收。
12. 键盘图层排序回归：固定 `phase2-professional-composite` Fixture 中，选择 `Blur and blend card` 后按 `⌘]`，Canonical Hash 从 `64d0d2307c85` 变为 `091732d52c5d`，浏览器控制台 `0 error`；Reset demo 后固定样例恢复。
13. 可复用 Dialog 焦点边界：`src/components/ui/dialog.tsx` 现统一提供 `role=dialog`、`aria-modal`、Escape 关闭、Tab/Shift+Tab 焦点环绕与关闭后的触发元素焦点恢复。真实浏览器工作区中，点击“新建项目”后首焦点位于输入框；Escape 关闭后焦点准确返回“新建项目”按钮，控制台 `0 error`。
14. 可复用 Tooltip：工具栏 `IconButton` 获得鼠标或键盘焦点时，会显示 `role=tooltip` 并由 `aria-describedby` 与按钮关联。真实浏览器中 `Move (V)` 提示正常显示，控制台 `0 error`。
15. 可复用 Menu 与 Roving Focus：工作区“更多操作”已使用 `src/components/ui/menu.tsx`，提供 `role=menu/menuitem`、方向键、Home/End 与 Escape。真实浏览器中菜单打开后焦点在“打开”，End 到“移至回收站”，Escape 收起并回到“Orbit 卡片探索 的更多操作”按钮，控制台 `0 error`。
16. Revision-bound 异步状态：`src/lib/revision-status.ts` 冻结异步任务的起始 revision；编辑器的远程同步、远程重置、本地文档持久化和视口持久化均仅在该 revision 仍当前时更新状态。单元测试覆盖相同 revision 允许、Undo 回退或远端推进 revision 时拒绝旧播报。
17. 键盘全选回归：真实浏览器固定 `phase2-professional-composite` Fixture 中，工具栏 `Move (V)` 获得焦点后按 `⌘A`，当前页面 21 个图层均进入选择，Inspector 的 live status 播报 `21 layers selected`；这是纯展示状态，Canonical Hash 保持 `64d0d2307c85`，控制台 `0 error`。输入框、文本域和画布内文本编辑仍保留原生全选行为。
18. 键盘取消选择回归：紧接全选后按未修饰 `Escape`，Inspector 恢复“Select an object to reveal its geometry, fill and layer settings.”空态，所有图层操作按钮禁用；Canonical Hash 仍为 `64d0d2307c85`，控制台 `0 error`。Canvas Text 编辑和 Pen 草稿先保留各自的 Escape 取消语义。
19. 键盘属性编辑回归：全局快捷键监听现在让出原生 `select` 控件。真实浏览器中选择 `Blur and blend card` 后将焦点置于 Blend mode，下按 `M` 由原生下拉框选择 `Multiply`（Hash `76d41c76dacd`），而非切换画布工具；Reset demo 后恢复 `Overlay`、`64d0d2307c85`，控制台 `0 error`。
20. Undo/Redo 选择连续性：全局捕获阶段现声明 `⌘Z` / `⌘⇧Z`，避免浏览器默认 Undo 抢走编辑命令。真实浏览器中 `Blur and blend card` 改为 `Multiply` 后，`⌘Z` 恢复 `Overlay` 与 `64d0d2307c85`、`⌘⇧Z` 恢复 `Multiply` 与 `76d41c76dacd`；两步的 Blend mode 控件均仍存在，证明选区未丢失，控制台 `0 error`。
21. Windows/Linux Redo 兼容性：`Ctrl+Y` 现等价于 `⌘⇧Z`。真实浏览器中先以 `Ctrl+Z` 将 `Multiply` 还原为 `Overlay` / `64d0d2307c85`，再按 `Ctrl+Y` 恢复 `Multiply` / `76d41c76dacd`；图层持续被选中，控制台 `0 error`。

## 自动验证

- `pnpm vitest run src/lib/selection-rotation.test.ts`：3 项通过，覆盖 Legacy 节点、Shift 吸附和含 Relative-v1 子节点的父级旋转。
- `pnpm vitest run src/lib/editor-key-command.test.ts src/lib/selection-nudge.test.ts src/lib/selection-move-roots.test.ts`：14 项通过，覆盖 1px/10px、旋转父级下的 Relative-v1 位移和现代容器/Legacy 子节点的去重规则。
- `pnpm vitest run src/lib/editor-key-command.test.ts`：11 项通过，覆盖非导航工具的无修饰 Enter 必须由编辑器抢占，不能落入仍持有焦点的工具栏按钮。
- `cargo test --workspace --quiet`：通过（新增 Core Shadow hash/undo/校验及 Protobuf Snapshot round-trip 覆盖）。
- `pnpm test`：542 项通过，覆盖 Drop Shadow 的 Protobuf 操作、SVG 降级报告及可视边界。
- `pnpm test -- editor-key-command layer-keyboard-navigation layer-keyboard-nesting workspace-store worker-recovery`：627 项通过；覆盖 R3 的键盘命令、图层 roving/nesting 与目录离线语义。
- `pnpm lint`、`pnpm build`、`pnpm protocol:check`、`pnpm wasm:build`：通过。

## 尚未关闭的 R3 条件

- 多选、镜像矩阵和含混合 Legacy/Relative-v1 树的真实浏览器矩阵尚待扩展；旋转精确恢复须在最终冻结源码上重新采集。
- Shadow 的单选 Canonical/Canvas/WebGPU fallback/SVG 降级/Snapshot 闭环已完成；Inspector 的 Same/Mixed/NotApplicable 语义、Effect Stack 精确滤镜输出留待 E1。
- 创建、选择、移动、缩放、旋转、重命名、排序、属性编辑、复制粘贴与删除的完整键盘覆盖仍未完成；图层 F2 改名与 Undo/Redo 的焦点恢复已收口，Dialog/Menu 的焦点关闭与恢复已收口；其余异步状态链路的 revision 审计与桌面屏幕阅读器独立验收仍待办。
