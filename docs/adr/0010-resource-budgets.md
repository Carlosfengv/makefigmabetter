# ADR 0010：Phase 0 文档与渲染表面资源预算

状态：已采纳（Phase 0 部分实现）

## 决定

- Canonical Document 最多接受 100,000 个节点，且以 `size_of(Node) + UTF-8 name/text` 的稳定估算累计最多 256 MiB。Create、Rename 与 SetText 都在 Reducer 修改前进行准入；删除、撤销和重做会同步更新该计数。
- Engine Worker 在设置 OffscreenCanvas 的像素宽高前，按 `ceil(width × DPR) × ceil(height × DPR) × 4` 估算 RGBA8 backing surface；单个表面上限为 512 MiB。无效、溢出或超预算尺寸不会覆盖上一个已确认表面。
- 可选 WebGPU Scene 的辅助 OffscreenCanvas 在创建/重配交换链及顶点数组之前，保守计算三张 RGBA8 swap-chain 表面加上每个可渲染节点 384 bytes 的六顶点数据；任何非空场景还计入实现实际分配的最小 4 KiB 顶点缓冲。场景缩小或清空会销毁过量/遗留缓冲，使准入记账继续等于实际请求资源；该派生资源池上限为 256 MiB。超限时不创建/重配 GPU Scene 资源，当前帧使用 Canvas 2D 完整回落，Document、Journal 和已存在的 GPU Device 不变；后续小场景可自动重新尝试 GPU Scene。
- Worker 读取 `WebAssembly.Memory.buffer.byteLength`，以 256 MiB 作为 WASM linear memory 的软预算。超限只写入一次 `WASM_HEAP_SOFT_LIMIT` 诊断并继续保留最近确认的 Document；回到预算内后可再次报告。Undo、Transaction、transactionId 去重与 operationId 去重继续使用各自的数量和估算字节预算；WASM 将节点数、节点估算字节数和所有这些统计提供给 Worker，界面只把它们作为瞬态运行证据显示。
- 隔离图片头探测器在 MIME 确认后、实际解码/Canvas/GPU 分配前必须给出正的安全整数宽高。Raster 单边最多 16,384 像素、总像素最多 256 Mi；超过 256 MiB RGBA8 工作预算的合法图片保留原始资源，并在 Worker 生成不超过该预算的渲染代理。缺失、非法或超限尺寸仍按结构化 `RESOURCE_LIMIT`/`INVALID_DIMENSIONS` 拒绝。
- 资源统计、性能采样与诊断事件是瞬态运行证据，不进入 Core Snapshot 或 Canonical Hash。

## 当前边界

项目已有独立 Asset Probe Worker：它在不进入 DOM、图像解码器或字体表解析器的前提下，对 SVG 做有界 UTF-8/结构预检，并从 PNG、JPEG、WebP 与常见字体容器读取有限头信息；请求可在实际读取前取消，取消后的结果也不会被投递。Worker 还会为在途探测以 request ID 与字节数预留 256 MiB 全局预算，超额请求在读取前以 `RESOURCE_LIMIT` 拒绝并在完成/取消后释放预留。WebGPU Scene 已对当前 swap-chain/vertex 资源作独立瞬态记账，但它不是图片、字体、SVG、导出或 wgpu 资源导入管线：CPU Asset 常驻预算、完整 GPU Texture/Buffer 图、可中断的完整解码与 LRU 淘汰仍未实现。256 MiB 是 Canonical Node 的保守准入估算；另一个 256 MiB WASM 预算是浏览器报告的已分配 linear memory 软阈值，Raster 的 256 MiB 是单资源工作位图预算，GPU Scene 的 256 MiB 是保守的单场景派生资源上限，四者不能相加后表述为准确进程内存。512 MiB 是主 Canvas backing surface 的安全预算，不能表述为实际 GPU 资源使用量。

## 后果

Core 回归测试已用真实 Reducer 路径装入 100,000 个基础节点，并确认第 100,001 个节点及字节超限的文本增长不会改变文档。Asset Probe Worker 与 TypeScript 资源契约会在 DOM/XML 解析前拒绝超过 1 MiB、20,000 元素或 64 层嵌套的 SVG，并在图片解码前从受支持格式的头信息拒绝畸形、非法或超限的 Raster 尺寸。后续资源管线必须在解码/分配前接入同一 `RESOURCE_LIMIT` 语义，并为超大图片、字体、深层 SVG 保留“Document 不变、资源可回落”的回归证据。
