# Phase 1.9–1.10：原生 Rust `wgpu` MainScene 证据

状态：受限 MainScene / Image / Text / Overlay / Composite 已验证；不是 Phase 1 完成声明。

## 覆盖内容

`makefigma-renderer-wgpu` 的 `native-wgpu-executor` 只在非 WASM 目标启用。它从不可变 `RenderGraph`、`GpuInstanceBatch`、Camera 数据、受控解码图片输入和可重建 glyph alpha mask 建立并提交真实的 Rust `wgpu` MainScene / Image / Text / Overlay / Composite Pass：

- Buffer、Uniform、Bind Group、Pipeline、Encoder 和 Queue 均由 executor 持有；Canonical Document、Asset 字节和 WASM 不持有 GPU Handle；
- 16-float 主场景实例布局与现有 Worker WGSL 合约一致，覆盖位置、旋转、圆角、椭圆、fill 和 inside stroke；
- Image Pass 以源/目标 aspect ratio 计算居中的 normalized `cover` UV；宽图填充方形和高图填充方形都由独立断言覆盖；
- executor 默认对实例缓冲、Image Texture 与单页 Glyph Atlas 执行 256 MiB 的预分配准入；低于 Atlas 所需空间的测试会得到 `ResourceBudgetExceeded`，并确认没有创建 Atlas；
- executor-owned RGBA8 离屏池按 `width × height` 复用、计入同一预算，并提供显式释放；借出的可克隆 TextureView 只服务当帧，不成为 Canonical 状态；
- `WgpuExecutorFactory` 保存 Adapter 和创建参数、但不保存任何派生缓存；平台在 Device Lost 后调用其单次 `rebuild` 可获得新的 Device/Queue/executor，随后必须从最新不可变 Render Graph 重放；
- 本机 headless 测试创建真实 Adapter、64×64 pooled 离屏纹理和一个红色 Rectangle；随后以 `Load` 叠加 1×1 蓝色 RGBA Image、实心 2×2 alpha mask 的绿色 glyph 与黄色 Overlay。Composite 将该结果复制到独立输出纹理。测试同时断言同尺寸池项复用不增加预算、释放后恰好回收该纹理占用。Image Texture 按不可变内容键缓存，Glyph 按 key 写入固定 1024×1024 R8 Atlas，二者的第二次绘制均不重传。提交后以 `COPY_SRC` 从输出纹理读回中心像素并验证为 `[255, 255, 0, 255]`；同一 Error Scope 未收到 WebGPU validation error；
- 无 Adapter 的 headless CI 可以安全跳过该硬件相关测试，其余 executor 合约测试仍会执行。

## 复现

```sh
cargo test -p makefigma-renderer-wgpu --features native-wgpu-executor
```

## 未覆盖内容

Image Atlas、复杂文本/RTL GPU 绘制、多页 glyph atlas、原生平台的 Device Lost 通知接线与浏览器主路径接管仍属于 Phase 1 后续工作。
