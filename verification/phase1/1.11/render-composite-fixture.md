# Phase 1.11：组合渲染夹具

状态：固定输入已自动验证；图片 Golden 的独立审核仍在 Phase 1。

`F-PHASE1-RENDER-COMPOSITE` 以一个经 SHA-256、PNG 签名、IHDR CRC 和像素尺寸核验的本地图像资源，固定验证以下同页组合：Frame、Image cover crop、Ellipse、Canvas 渐变覆盖层与 Text。

```sh
pnpm check:phase1-render-composite-fixture
```

浏览器可通过 `/?fixture=phase1-render-composite` 打开。该夹具在 Core 建立后先注册资源，再以原子 Transaction 创建引用该 `AssetId` 的 Image 节点；因此它覆盖 Resource Index → WASM → Worker decode → WebGPU Image Pass 的真实边界，而不把图片字节写入 Canonical Document。

可采集固定 1440×960 的截图、可访问性快照、控制台和输入/manifest 哈希：

```sh
bash scripts/capture-phase1-render-composite-evidence.sh \
  http://127.0.0.1:3000 \
  output/phase1-render-composite/local-run
```

采集器要求 WebGPU scene active、Rust/WASM bridge ready 和 0 条浏览器 console error。默认先预热 30 秒，再通过同一已就绪会话中的三轮、每轮 240 次动画帧分离输入，保存每轮和中位 P50/P95/Max；每轮正好覆盖 Worker 的 240 样本滚动窗口，因此启动上传不会混入稳态指标。Golden 仍明确标记为待独立审核。

带图片纹理的 Device Lost 恢复使用下面的独立脚本。它仅在开发夹具下等到 ImageBitmap 已绑定至可见 Image 节点后才销毁 GPU Device，随后要求 `WebGPU scene recovered (1)`、截图和 0 条 console error：

```sh
pnpm evidence:phase1-image-recovery \
  http://127.0.0.1:3000 \
  output/phase1-image-recovery/local-run
```

这份输入契约和自动测试不构成跨环境图片 Golden 的人工签收；正式 Golden 仍须固定浏览器、视口、DPR 与审阅人。

组合夹具的核心编辑交互也可以独立复现。采集器从实时可访问性快照解析并点击 Rectangle 工具，再发送画布指针事件创建一个矩形，随后使用 `⌘Z`/`⌘⇧Z` 验证 Canonical 节点数经历 `5 → 6 → 5 → 6`，并要求 0 条浏览器 console error：

```sh
pnpm evidence:phase1-editing \
  http://127.0.0.1:3000 \
  output/phase1-editing/local-run
```

2026-08-05 在本地候选环境 `http://127.0.0.1:3013` 的实际采集结果保存在 `output/playwright/phase1-editing/current-candidate/`：工具栏创建、画布指针绘制、撤销和重做的节点数依次为 `5 → 6 → 5 → 6`，控制台错误为 `0`。该结果只证明本地编辑链路可复现；不替代跨环境 Golden 审核或 30 分钟稳定性验收。
