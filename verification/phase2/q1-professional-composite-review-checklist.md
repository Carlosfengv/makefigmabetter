# Phase 2 Q1：Professional Composite 独立审核清单

- 审核范围：`?fixture=phase2-professional-composite` 的 1440×960、DPR 1 候选。
- 审核原则：采集者不能审核或冻结自己的 Golden、60 分钟稳定性与视觉结论。
- 当前状态：准备就绪，等待完整稳定性候选结束后由独立审核者填写；不是通过声明。

## 1. 冻结前置条件

- [ ] 候选目录同时包含起止截图、`browser-environment.txt`、`console.txt`、`cycles.tsv`、每轮 `action-run-*.txt` 和 `performance-run-*.txt`。
- [ ] 浏览器环境为 1440×960、DPR 1，渲染状态为 `WebGPU + Canvas 2D overlay`，且 `Rust/WASM bridge ready` 与 3 个资源均已就绪。
- [ ] `console.txt` 显示 `Errors: 0`。
- [ ] 每轮动作归档都包含 `pan`、`zoom`、`select`、`move`、`resize`、`rotate`、`text`、`layout`、`effect`、`undo`、`redo`。
- [ ] `performance-summary.json` 的三项本地阈值均通过：Render P95 < 12ms、Input-to-render P95 < 50ms、Input backlog P95 < 32ms。
- [ ] 候选源码、`src/lib/phase2-professional-composite-fixture.ts` 和 [Golden manifest](q1-professional-composite-golden-manifest.json) 的 SHA-256 已一并记录；任何变动均须重采。

## 2. 视觉与交互复核

- [ ] 三层 Auto Layout 的 Gap、Padding、Hug/Fill、绝对定位子项和嵌套层级符合预期。
- [ ] Frame Clip 与两段独立 alpha Mask 均只影响各自 sibling run；无遮挡内容、裁剪或命中穿透。
- [ ] Polygon、Star、Vector、Boolean/Outline、Slice 的层级、选择和视觉结果正确。
- [ ] Image fallback、内嵌 Inter 字体，以及中文、阿拉伯文和 Emoji 的系统 fallback 均可读、无异常替代字符。
- [ ] Layer/Background Blur、Inner/Drop Shadow 与 Blend 的叠放顺序正确；无明显闪烁、黑块或透明度错误。
- [ ] 在实际编辑器中执行图层移动、Resize、Rotate、文本编辑、布局、效果切换和 Undo/Redo；没有出现引擎错误提示。

## 3. Golden 冻结

- [ ] 独立审核者选定候选的起始截图作为基线，并复制至 `fixtures/golden-images/phase2-professional-composite.png`。
- [ ] 审核者把该文件的 SHA-256 写入 manifest 的 `baselineSha256`，将 capture `status` 改为 `reviewed`。
- [ ] 运行 `pnpm check:phase2-professional-composite-golden <candidate.png>` 返回 `pass`；若返回 `pending`，说明尚未冻结，若返回 `fail`，不得签署。
- [ ] 审核者在本文件下方记录日期、候选目录、源码标识、结论和姓名/身份。

## 4. 签署记录（仅独立审核者填写）

| 项目 | 记录 |
| --- | --- |
| 候选目录 | 待填写 |
| 审核日期 | 待填写 |
| 源码/Fixture 标识 | 待填写 |
| Golden | 待填写 |
| 60 分钟稳定性 | 待填写 |
| 视觉与交互 | 待填写 |
| 审核者 | 待填写 |
