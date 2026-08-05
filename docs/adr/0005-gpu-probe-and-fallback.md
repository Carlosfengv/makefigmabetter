# ADR 0005：GPU 探测、降级与恢复边界

状态：已采纳（Phase 0 验证）

## 决定

- Engine Worker 是 GPU capability 的唯一探测者；主线程不持有 `GPUDevice`，也不为逐帧状态做 GPU 调用。
- 当前生产原型会在独立的辅助 `OffscreenCanvas` 上创建实际 WebGPU Scene Renderer，绘制实色 Frame / Rectangle / Ellipse 的填充与描边、已解码 `ImageBitmap` 的采样 Image Pass，以及受限单字体 LTR 文本的 alpha-mask Text Pass。图片纹理按 `AssetId` 在当前 Device generation 内复用；文字位图写入单张固定 1024×1024、带 1px padding 的 R8 Glyph Atlas，再通过 atlas UV 绘制。无法装入或未满足文字限制的节点保持 Canvas 覆盖层，避免部分字形重复绘制。所有派生纹理和实例缓冲均在预算内回收。辅助表面以透明背景输出 ImageBitmap，再与主 OffscreenCanvas 的 Canvas 2D 图层合成。渐变仍由 Canvas 2D 覆盖层绘制。超过 400% 时，1px 精度网格会最后绘制并覆盖所有图层和选中态；低于该倍率不绘制网格。没有 WebGPU、初始化失败或渲染失败时，主 Canvas 保持完整 Canvas 2D 回退。UI 只有在该 Scene Renderer 已成功创建时才表述为“WebGPU scene active”。
- WebGPU Renderer 的 `device.lost` Promise 触发时，Worker 最多尝试一次延迟重建；第二次失败或没有 Adapter 时进入稳定 Canvas 2D 降级状态，不进行无限重试。Document、Journal 与 Canvas 2D 覆盖层不受该派生资源失败影响。
- 开发环境可在固定 `phase0-basic-card` Fixture 上显式传入 `simulateGpuLoss=1` 或 `=2`。Worker 每次 WebGPU Scene ready 后调用该真实 Device 的 `destroy()`：一次验证有界恢复，两次验证恢复耗尽后稳定降级。参数被限制为 0–2；生产构建和其他 URL 忽略该参数。恢复次数仅作为瞬态 Snapshot 证据呈现。
- 每帧 GPU Scene 在分配前执行独立的 swap-chain/vertex 预算。预算拒绝不是 Device Lost：Device 保持可用，Worker 只以 Canvas 2D 绘制当前帧并记录结构化资源诊断；场景或表面缩小后可以重新进入 WebGPU Scene。

## 后果

该 TypeScript/WGSL Scene Spike 验证 Worker 内真实 WebGPU 的形状、基础图片与受限文字资源创建、提交、合成与恢复边界；它不是架构目标中的 Rust `wgpu` Render Graph，也不覆盖完整 GPU 文本、渐变、广色域、Clip/Mask 或导出。后续引入 Rust `wgpu` Render Graph 时，必须替换这一过渡路径、保留同样的有界恢复语义，并新增 Device Lost 后从最新确认 revision 重建 GPU 资源的 Golden/浏览器回归。
