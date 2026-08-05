# Phase 1.9：浏览器 Render Graph 候选证据

状态：本地自动化候选通过；Golden 和跨环境验收尚未完成。

正式架构见 [ADR 0022](../../../docs/adr/0022-browser-render-graph-executor.md)：Rust/WASM 从
Canonical Document 投影不可变的 pass order 与 solid-shape instance batch；Engine Worker 独占
WebGPU 执行、资源和回退状态；React 不保存逐节点 GPU 语义。

本地固定 `F-PHASE1-RENDER-COMPOSITE` 夹具已验证其输入清单、资源 hash 与节点组合：

```sh
pnpm check:phase1-render-composite-fixture
```

在运行中的开发栈上，采集器要求 Rust/WASM bridge ready、WebGPU scene active 和浏览器
console 0 errors，并记录固定视口截图、输入性能样本及 fixture manifest：

```sh
pnpm evidence:phase1-render-composite \
  http://127.0.0.1:3013 \
  output/phase1-render-composite/<build-id>
```

`evidence-metadata.json` 还记录 user agent、视口、DPR、WebGPU 可用性和截图/Fixture 的 SHA-256。
它附带一个**候选** RGBA 像素策略（单 channel delta ≤ 2、不同像素比例 ≤ 0.5%、默认无允许区域），
但状态固定为 `pending-independent-review`；只有非实现者在冻结浏览器/GPU/DPR 环境审阅后才能把该
策略与截图升级为 Golden。

2026-08-05 的本机候选采集在 `127.0.0.1:3013`、1440×960、DPR 1、WebGPU 可用的 Headless Chrome
环境完成。固定 fixture 经 30 秒预热和三轮各 240 样本的缩放输入后，P95 中位数为 `0.73ms`，三轮
最大值中位数为 `1.095ms`，浏览器 console 为 0 errors。原始截图、环境、三轮指标、摘要和候选
RGBA 策略位于 `output/playwright/phase1-render-composite/current-candidate/`；metadata 的 Golden 状态
仍为 `pending-independent-review`。

## 2026-08-05：Rust Graph 浏览器执行边界

Engine Worker 现读取 Rust/WASM 的当前页面 Graph 命令序列来排序可见节点；Canvas fallback
仍保留同一命令序列中的层间交错，因而不会因 GPU 固定 pass 顺序改变 Document z-order。若 Graph
缺节点、无法解析或 revision 不匹配，Worker 会记录 `RUST_RENDER_GRAPH_UNAVAILABLE` 并安全回退到
本地排序，而不会跳过节点。

本机 `http://127.0.0.1:3013/?fixture=phase1-render-composite` 的实测证据位于
`output/playwright/phase1-render-graph/current-live/`：Rust/WASM 与 WebGPU 均就绪，5 个可见节点的
P95 总渲染时间为 `0.685ms`，诊断不含 `RUST_RENDER_GRAPH_UNAVAILABLE`，浏览器 console 为 `0` errors。
这证明当前候选构建已走到 Rust Graph 命令边界；它不替代 Golden 或 B1–B4 独立验收。

该结果仍不是 1.9 PASS：图片、文本、渐变 fallback、Overlay 与组合场景的 Golden 必须绑定
提交并由非实现者在 B1–B4 独立审核后冻结。
