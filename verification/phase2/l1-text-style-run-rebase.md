# Phase 2 L1 验收记录：文本替换、选区样式与 Run 级颜色

- 日期：2026-08-08
- 状态：自动候选通过；不代表高级文本 Gate 完成。
- 覆盖源码：`src/lib/text-style-run-edit.ts`、`src/components/editor/editor-shell.tsx`、`crates/editor-core/src/lib.rs`、`crates/editor-wasm/src/lib.rs`、`src/workers/editor.worker.ts`、`src/lib/svg-export.ts`。

## 实现

Canvas `contenteditable` 和 Inspector `textarea` 的完整文本替换现在共用同一 UTF-8 Style Run 重定位逻辑。它比较替换前后的 Unicode scalar 序列，按字节计算变更区间，保留未编辑区间的 Canonical runs，并让插入区间继承 selection-start 的样式；相邻的相同样式会重新合并。

Inspector 的 textarea 还会将当前 DOM selection 从 UTF-16 安全映射到 UTF-8，令 Font、Size、Weight、Italic、Tracking 和 Variable axes 更新只作用于所选 run 区间。折叠 selection 保留既有整段编辑行为，避免改变已有键盘流程。

Run 级颜色现已成为可选的 Canonical `TextStyleRun` 字段：省略时继承 Text 节点 fill；存在时它会参与合法性校验、Canonical Hash、Core Undo/Redo、protobuf 快照与操作适配、WASM 投影/快照恢复。Canvas 对每个 span 使用其颜色绘制，GPU 文本路径在遇到 run 颜色时保守回退到 Canvas，SVG 为相应 `tspan` 输出 `fill`。Inspector textarea 提供 `Text selection color` 控件，并沿用同一 UTF-16 到 UTF-8 选区映射更新目标 run。

这避免了此前任意文本编辑都将所有内容压缩为首个 Style Run 的数据丢失路径。未样式化或不完整的旧投影继续保守地保留为空 run 集，以便 Core 维持自己的合法性校验。

## 自动验证

- `cargo test -p editor-core rich_text_run_color_is_hashed_undoable_and_validated`：通过；覆盖 Hash、Undo/Redo 与非法颜色拒绝。
- `cargo test -p editor-wasm text_batch_round_trips_canonically_and_v2_snapshots_remain_readable`：通过；覆盖带颜色 run 的快照恢复。
- `pnpm vitest run src/lib/text-style-runs.test.ts src/lib/text-style-run-edit.test.ts src/lib/svg-export.test.ts`：28 项通过；覆盖颜色不合并与 SVG `tspan fill`。

## 未关闭条件

- 尚未提供 Canvas contenteditable 的选区级样式控件和 Text selection Mixed Inspector。
- 富文本剪贴板、HTML 清洗、段落级交互、SVG/PDF 统一输出、IME/RTL 的完整浏览器矩阵仍待 L1 收口。
