# Phase 2 P1-2 验收记录：Mixed Inspector 能力矩阵与屏幕阅读器 live region

- 日期：2026-08-09
- 计划条目：`docs/phase2-remediation-plan.md` P1-2
- 状态：自动验收已过；**独立人工/AT 复核仍待冻结**(`signOff.status = pending-independent-review`)。

## 交付物

1. **单一来源 tri-state 解析器** `src/lib/inspector-capability-matrix.ts`
   - `inspectorCapabilityMatrix(nodes)`：把「适用性」(来自 `mixedInspectorCapabilities`) 与「取值一致性」(来自 `mixedSelectionValue` 对每字段的可比摘要) 合并为每格 `same | mixed | notApplicable`。
   - `inspectorCapabilityAnnouncement(nodes)`：由同一矩阵派生屏幕阅读器语句，保证朗读内容与可见 Inspector 不漂移。

2. **表驱动矩阵测试** `src/lib/inspector-capability-matrix.test.ts`
   - 行 = NodeKind 组合等价类：空选区、8 种同构单选 (frame/rectangle/ellipse-full/ellipse-arc/line/text/image/section/group)、含 Group、含 Section、含 Line、含 Arc、含 Text、含 Image 的敌对混选，以及隔离每列的取值分歧变体。
   - 列 = 10 个能力字段 (fill / strokeWidth / strokeAlign / perSideStroke / corners / strokeDetails / lineStroke / frameClip / sectionContents / dropShadow)。
   - 每格固化 `Same/Mixed/NotApplicable`；另有断言杜绝三态以外的返回值。
   - 结果：**28 项全绿** (`pnpm vitest run src/lib/inspector-capability-matrix.test.ts`)。

3. **live region 接线** `src/components/editor/editor-shell.tsx`
   - 多选 `.selection-title` 为 `role="status" aria-live="polite"`，新增 `data-selection-capabilities` 与 `.visually-hidden` 文本，二者同源自 `inspectorCapabilityAnnouncement`。
   - `.visually-hidden` helper 加入 `src/app/globals.css`(标准 clip 隐藏,仅对 AT 可见)。

4. **脚本化 a11y 端到端验收**
   - `scripts/capture-phase2-inspector-a11y-evidence.sh`：在真实浏览器载入 `?fixture=phase2-common-nodes`，从新鲜 accessibility snapshot 解析 LayerPanel 行的 ref，再以真实 Playwright 操作执行「点击 Frame → 按住 Shift 追加 Text」。它读取 live region 的 `role/aria-live/data-selection-capabilities/.visually-hidden`，并断言：角色 `status`、`aria-live=polite`、data 属性与朗读文本一致、句子含选中计数 + `Editable: Drop shadow.` + `Mixed values: Fill.` + `Not applicable: …Stroke width…Section contents.`。console 必须 0 error。
   - `scripts/write-phase2-inspector-a11y-evidence.mjs`：产出 `evidence-metadata.json`(`format = makefigma-phase2-inspector-a11y-evidence-v1`),记录选区、live region 语句、构件 SHA-256、以及 `signOff.status = pending-independent-review`。
   - `scripts/capture-phase2-inspector-a11y-evidence.test.mjs`：以伪 Playwright worker 端到端跑通脚本(含元数据断言),并反向验证「丢失 Mixed/NotApplicable 子句时脚本必须非零退出」。**2 项全绿**。
   - npm 入口：`pnpm evidence:phase2-inspector-a11y`。

## 敌对混选的预期朗读

选中 `Root Frame` + `Fixture label` (frame + text)：Drop shadow 是唯一共同可编辑项，Fill 的值不同，其他专用控件不适用，故：

```
2 layers selected. Editable: Drop shadow. Mixed values: Fill. Not applicable: Stroke width, Stroke align, Per-side stroke, Corner radius, Stroke details, Line endpoints, Clip content, Section contents.
```

## 待办(计入 Gate 前)

- 已于 2026-08-09 在 3080 测试环境真实采集，产物在 `output/playwright/phase2-inspector-a11y/20260809T1240Z/`，其中 `evidence-metadata.json` 记录 fixture SHA-256、朗读文本和 `Errors: 0`。2026-08-10 又在当前工作树以同一 3080 夹具复采，产物在 `output/phase2-a11y/recheck-20260810/`；其 live region 逐字验证为 `2 layers selected. Editable: Drop shadow. Mixed values: Fill. Not applicable: Stroke width, Stroke align, Per-side stroke, Corner radius, Stroke details, Line endpoints, Clip content, Section contents.`，并保持 `Errors: 0`。仍需将候选目录交独立审核者。
- 独立审核者以真实屏幕阅读器 (VoiceOver / NVDA) 复听 live region,签署并冻结 baseline,将 `signOff.status` 从 `pending-independent-review` 置为已冻结。
