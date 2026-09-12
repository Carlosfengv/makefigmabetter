# Phase 2 Q1：Professional Composite 候选记录

- 日期：2026-08-10
- 状态：本地候选；不构成 Golden、60 分钟稳定性或设计师综合验收的签署。
- 固定入口：`?fixture=phase2-professional-composite`

## 已自动验证

- `cargo test -p editor-wasm legacy_seed_assets_are_available_before_seeded_image_nodes`：资源索引会在遗留投影的 Image 节点导入前进入 Core，节点和资源索引均会写入快照。
- `cargo test -p editor-wasm projection_parametric_shapes_accept_browser_camel_case_fields`：浏览器投影的 `pointCount` / `innerRatio` 能被 WASM 正确导入，避免 Polygon 或 Star 令整个夹具降级。
- `pnpm wasm:build` 与 `pnpm build`：WASM 生成物和生产类型检查均通过。

## 浏览器候选

- 夹具加载后显示 `Rust/WASM bridge ready`、24 个节点、3 个资源及固定 Canonical Hash；两段 alpha Mask run 分别封装在独立 Group 中，因此只裁剪各自的后续 target，不会吞掉无关的根级图层；其中还包含一条仅由 Layer Blur + Drop Shadow 组成的有序效果栈；控制台无 error。
- 内嵌的 Inter TTF 子集在主线程 `document.fonts` 中以 `makefigma-asset-…30f1` 注册为 `loaded`；文本仍含中文、阿拉伯文和 Emoji，用于覆盖未包含字形时的系统 fallback，而不向 Canonical 文本写入未登记的 Font AssetId。
- 当前稳定性脚本已按现用 Playwright CLI 兼容格式完成真实 0 秒、三轮动作烟雾采集：每轮执行 Pan、Zoom、Select、Move、Resize、Rotate、Text、Layout、Effect、Undo/Redo 后 Reset demo，起止截图、环境、动作归档、性能摘要、浏览器堆内存曲线与 console 全部写入候选；中位 Render P95 为 3.435ms、Input-to-render P95 为 21ms、Input backlog P95 为 18.74ms，console 为 0 error。该产物仅证明采集链路，不构成 60 分钟签署。
- 选择 `Polygon` 后执行图层面板的“置顶”操作，Canonical Hash 变更为 `947782a63b1e…`，未出现引擎错误；同时修复了并发工作区目录保存的 409 不应冒充编辑失败的问题。重新打开固定入口可恢复基线 Hash。
- 选择嵌套 `Auto layout level 1` 后执行 ⌘C/⌘V，节点数从 `19` 变为 `25`、Hash 变为 `584868abbed4…`；选择 `Boolean union` 后执行 ⌘C/⌘V，节点数从 `19` 变为 `22`、Hash 变为 `76cb0515b828…`；两项均为控制台 `0` error 的候选证据。

## 正在进行 / 待办

- 下一轮将写入 `output/phase2-professional-composite/stability-20260809-workspace-conflict-fix/`，以包含目录并发保存修复的源码重新执行完整 60 分钟候选采样；启动门槛要求同时出现 Worker 在线、`Rust/WASM bridge ready` 和 3 个资源，避免回退模式生成候选。`stability-20260809-rust-wasm-verified/` 与 `stability-20260809-post-autolayout-fix/` 均发生在本轮源码变更前，仅保留作历史诊断，不能作为冻结 Gate 证据。
- 独立 Golden 冻结、完整稳定性结论与设计师验收仍待独立审核者完成。
- 已新增 [Q1 Golden manifest](q1-professional-composite-golden-manifest.json) 与 `pnpm check:phase2-professional-composite-golden <candidate.png>`：它固定 1440×960、DPR 1、WebGPU + Canvas 2D overlay、当前 Fixture SHA-256；在审核者录入基线文件及其 SHA-256 前会明确返回 `pending`，不会由采集脚本自行升级候选。
- 独立审核使用 [Q1 Professional Composite 审核清单](q1-professional-composite-review-checklist.md)；它将动作、性能、视觉、Golden 与签署记录拆开，避免把“采集成功”误写为“验收通过”。
