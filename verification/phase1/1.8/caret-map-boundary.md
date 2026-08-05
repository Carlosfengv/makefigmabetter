# Phase 1.8：画布编辑 Caret Map 边界

状态：Rust 合法 caret boundary 已接入浏览器编辑器；不是 Phase 1 完成声明。

## 覆盖内容

- 画布双击 Text 后，`contentEditable` 只充当浏览器输入法宿主；其 UTF-16 选择位置不进入 Canonical Document；
- 主线程把节点、当前文本和 DOM caret 发给 Engine Worker；Worker 调用 Rust/WASM
  `fallback_text_layout_json`，返回不拆分 grapheme 的 UTF-8 caret stops；
- 主线程以 Core 同样的最近-offset/tie-break 规则转换回 UTF-16 DOM selection；异步响应只在 node/text
  仍匹配时应用，避免旧编辑会话覆盖新草稿。未带修饰键的左右方向键以及 Shift+左右方向键同样只在
  这份 Rust caret map 的合法 stops 之间移动或扩展选区；
- 在映射已就绪且不处于 composition 时，`beforeinput` 对 Backspace、Delete、普通替换与换行先将
  DOM 选区压到 Rust stops，再重建草稿；因此单次删除与替换不能截断 Emoji surrogate pair 或其他
  Rust 不允许的边界。编辑态 `contentEditable` 不再把 Backspace 冒泡为画布对象删除快捷键；
- DOM 编辑、composition 草稿和 Escape 取消不会提交 Transaction，只有失焦或 ⌘/Ctrl+Enter 才提交单个
  Canonical text update。
- Engine Worker 重启会保留未提交的 DOM 草稿，但立即清除旧 Worker 的 Rust layout；新 Worker 的
  Rust/WASM bridge ready 后必须重新返回合法 stops 才恢复编辑。页面切换则先取消该页面的未提交草稿，
  防止已离开画布的 selection 误写入另一页。

## 自动验证

```sh
pnpm exec vitest run src/lib/rust-text-caret.test.ts
```

测试覆盖 UTF-8/UTF-16 转换、Emoji surrogate-pair 的稳定向前取整、Backspace/Delete 的完整
grapheme 删除、选区替换，以及无效 Worker payload 的拒绝。

## 浏览器演练

```sh
pnpm evidence:phase1-text-caret \
  http://127.0.0.1:3000 \
  output/playwright/phase1-text-caret/<build-id>
```

在本地开发环境中打开 `?fixture=phase0-basic-card`，双击 `Headline`，并输入 Emoji。编辑器元素的
`data-rust-caret` 会从 `pending` 变为 `ready`；最近一次 Chromium 演练在初始进入编辑和输入 Emoji 后
均为 `ready`，浏览器控制台为 0 errors。组合输入演练还验证了 `compositionstart`/`insertCompositionText`
期间保持 `pending`，只在 `compositionend` 后回到 `ready`；随后以末尾 CJK 字符检查 ArrowRight 和
Shift+ArrowLeft，确认移动/选区没有落入非法 UTF-8 boundary。该标志只是瞬态验收证据，不保存到 Snapshot。

2026-08-05 的另一独立 Chromium 演练在同一真实 `contentEditable` 中将草稿设为 `A😀中`，把 selection
置于 Emoji 之后后发出 `deleteContentBackward`。`beforeinput` 返回 `accepted=false`，可见文本变为
`A中`；选择 `中` 并发出 `insertText("B")` 后同样返回 `accepted=false`，可见文本变为 `AB`。异步
Rust layout 回应后为 `ready`，caret 为 UTF-16 offset `2`，控制台为 0 errors。这证明取消默认 DOM
路径后仍真实改写可见编辑内容，而不仅是更新 React 草稿状态。

`F-TEXT-MULTILINGUAL` 当前还将 `office fi ffi` 与双轴 `wdth`/`wght` Variable Font 输入、显式
fallback FontReference 和 `汉字 □` 缺字输入固定到带 hash 的 fixture 中。`pnpm check:phase1-text-fixture`
会验证 UTF-8 style-run 边界、双轴契约与 fallback 语义案例；它提供可重放的自动输入，但不替代
真实字体字节的跨平台布局/alpha Golden。

2026-08-05 在 `http://127.0.0.1:3013` 完整执行
`pnpm evidence:phase1-text-caret http://127.0.0.1:3013 output/playwright/phase1-text-caret/current-full`。
采集器通过了 composition `pending → ready`、CJK 边界的 ArrowRight/Shift+ArrowLeft、完整 Emoji
Backspace 删除与 CJK 选区替换；控制台为 `0` errors。原始 snapshot、操作日志和摘要保留在该
被忽略的 `output/playwright/` 目录中。

同日的编辑态重启候选演练使用 development-only 参数 simulateWorkerCrash=1 和
simulateWorkerCrashDelayMs=2000：先把真实 contentEditable 草稿设为 A😀中 并等待 Rust caret
ready，再触发 Engine Worker 重启。重启后页面显示 Rust/WASM bridge ready 与 recovered confirmed
snapshot，草稿仍为 A😀中，新的 caret 状态为 ready，控制台为 0 errors。证据保存在
output/playwright/phase1-text-edit-recovery.*；该结果证明旧 layout 不会被复用，不替代复杂脚本、
RTL 或视觉 x/y caret 的跨环境验收。

## 尚未覆盖

此边界尚不等同于完整文本交互：复杂脚本的视觉 x/y caret、RTL 的视觉方向键语义、上下方向键、
完整 IME preview 和跨 Style Run 的画布坐标仍须使用 Rust shaping 结果继续收口。
