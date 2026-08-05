# Phase 1.5：隔离资源解码候选记录

状态：本地自动验证通过；不是 Phase 1 完成声明。

## 已验证边界

- `Asset Probe Worker` 在任何像素分配前验证 MIME、容器头、字节数、声明尺寸和资源预算；
- `Asset Decode Worker` 是唯一使用 `createImageBitmap` 的解码边界。它请求 EXIF orientation
  归一化、默认色彩转换到 sRGB、非预乘 alpha，并在结果返回前再次验证真实尺寸和解码内存；
- JPEG EXIF、PNG/WebP alpha、PNG/JPEG/WebP 中的嵌入 ICC 声明仅保留为有界诊断元数据，不进入
  Canonical Document；
- `AbortSignal` 取消会终止短生命周期 Decode Worker；解码已经完成但未被接收的 `ImageBitmap`
  会关闭，不能写入 Document 或缓存；
- CPU `ImageBitmapCache` 以已解码 RGBA 字节计费并执行 LRU 淘汰，超过预算时不保留投影。

## 自动证据

```sh
pnpm exec vitest run \
  src/lib/asset-probe.test.ts \
  src/lib/raster-decode-policy.test.ts \
  src/lib/phase1-asset-hostile-fixture.test.ts \
  src/lib/image-bitmap-cache.test.ts \
  src/workers/asset-probe.worker.test.ts \
  src/workers/asset-decode.worker.test.ts
```

其中 Decode Worker 用例覆盖成功的受控解码、头部与真实尺寸不一致时关闭 bitmap 并拒绝、以及
取消后关闭迟到 bitmap。`F-ASSET-HOSTILE` fixture 覆盖伪造 MIME、截断/损坏和资源限制的确定结果。

## 尚未构成 PASS 的项目

需要在 B1–B4 环境以真实浏览器解码器复核 P3/ICC 的像素 Golden、具体 JPEG 方向样本、字体炸弹
和导入取消录屏；这些跨环境人工证据尚未冻结。
