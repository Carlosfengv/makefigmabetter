# Phase 1.10：浏览器 Device Lost 候选证据

状态：本地真实浏览器故障注入通过；不是跨环境 Gate 的完成声明。

`scripts/capture-phase1-gpu-recovery-evidence.sh` 在真实 Chromium WebGPU Device 创建之后注入
一次或两次 `destroy()`。每个采集用唯一的 Playwright 会话名，避免异常退出或并行采集复用旧页面。

在 2026-08-05 的本地开发栈复验中：

- 第一次丢失后，界面达到 `WebGPU scene recovered (1)`，控制台为 0 errors；
- 第二次连续丢失后，界面稳定显示 `Canvas 2D · WebGPU recovery exhausted`；Rust/WASM bridge
  仍 ready，控制台为 0 errors；
- 过程只销毁派生 GPU 资源，未重置 Canonical Document、操作队列或本地服务。

复现命令：

```sh
pnpm evidence:phase1-gpu-recovery \
  http://127.0.0.1:3013 \
  output/playwright/phase1-gpu-recovery/<build-id>
```

浏览器渲染器还会把未捕获 GPU 错误和同步渲染异常归类为不含浏览器错误文本的固定诊断码。
开发专用 URL 故障注入经由与真实未捕获错误相同的 renderer listener 进入 Engine Worker，便于稳定
验证处理策略：

~~~sh
pnpm evidence:phase1-gpu-fault \
  http://127.0.0.1:3013 \
  output/playwright/phase1-gpu-fault/<build-id>
~~~

2026-08-05 的本地 Chromium 候选采集保存在
output/playwright/phase1-gpu-fault/current-candidate/。三个场景的控制台均为 0 errors：

- WEBGPU_OUT_OF_MEMORY：销毁派生资源，并达到 WebGPU scene recovered (1)；
- WEBGPU_VALIDATION_ERROR：保留仍有效的 Device，同时保留结构化诊断；
- WEBGPU_UPLOAD_FAILED：销毁派生资源，并达到 WebGPU scene recovered (1)。

该故障注入验证的是浏览器错误分类、诊断记录和有界恢复路径，不是对特定驱动的真实 OOM/Validation
条件的跨环境证明。仍缺少冻结 commit 上的恢复前后 Golden、B1–B4 矩阵、真实设备错误矩阵与独立
审核。因此此记录不能将 1.10 或 Phase 1 标记为 PASS。
