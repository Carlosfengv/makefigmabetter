# Phase 1.11：服务重开恢复验证

状态：自动化覆盖已建立；不是 Phase 1 完成声明。

## 覆盖内容

- `makefigma-document-api::tests::durable_http_reopen_serves_the_accepted_snapshot_and_idempotent_replay`
  - 使用临时 SQLite 数据库，经真实 Protobuf HTTP 路由创建 Document 并提交 Operation；
  - 丢弃首个 Router/Service，重新打开同一数据库；
  - 验证 Snapshot 的 Canonical revision 为 `1`，相同 Operation 重放仍返回 accepted revision `1`。
- `makefigma-asset-api::tests::durable_http_reopen_retains_attached_asset_delivery`
  - 使用临时 SQLite 数据库，经真实 HTTP 路由完成 PNG 上传、writer 授权和 Document 附加；
  - 丢弃首个 Router/Service，重新打开同一数据库；
  - 验证仍可按 Document 授权签发新的短期下载凭据，下载字节与原始内容完全相同。

## 复现

```sh
cargo test -p makefigma-document-api -p makefigma-asset-api
```

该证据只证明 Phase 1 单客户端本地 SQLite 的服务重开语义。网络进程编排、跨机器故障转移和多客户端并发属于后续阶段。

## GPU Device Lost 浏览器证据

`scripts/capture-phase1-gpu-recovery-evidence.sh` 在固定 `phase0-basic-card` 页面上销毁真实当前 WebGPU Device，并通过与生产 `GPUDevice.lost` 共用的失效处理入口对两条有界恢复路径各采集一次可访问性树和控制台记录。这样在 Chromium 没有及时兑现第二次显式 `device.lost` Promise 时，已失效的当前 renderer 仍会立即进入相同的安全回退状态机：

- `simulateGpuLoss=1`：状态为 `WebGPU scene recovered (1)`；
- `simulateGpuLoss=2`：状态为 `WebGPU recovery exhausted`，随后保持 Canvas 回退；
- 两个场景的浏览器错误数均为 `0`。

复现：

```sh
pnpm evidence:phase1-gpu-recovery \
  http://127.0.0.1:3000 \
  output/phase1-gpu-recovery/local-run
```

最近一次本机成功采集写入 `output/phase1-gpu-recovery/verified-20260804T135638Z/`。它证明现有 TypeScript/WGSL 过渡渲染器的浏览器恢复边界，不替代 Rust `wgpu` 重建、GPU Atlas 或图像 Golden。
