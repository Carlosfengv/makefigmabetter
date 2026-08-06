# ADR 0022：浏览器 Render Graph 的正式执行路径

状态：已采纳（Phase 1；Golden 验收待冻结）

## 决定

浏览器主路径采用 **Rust 生成不可变 scene/render graph，Engine Worker 中的 TypeScript
WebGPU executor 执行该 graph**。Phase 1 不把 Rust `wgpu` executor 编译进浏览器 WASM。

- Rust Core 是唯一 Canonical Document 状态机；Rust/WASM 按 revision 导出 shape
  instance batch、rendered node id 与固定 pass order（MainScene → Images → Text → Overlay
  → Composite）。
- Engine Worker 独占 `GPUDevice`、OffscreenCanvas、纹理、buffer、atlas 和 Device Lost
  生命周期。React 只传输入与消费已合成的位图，不发起逐节点 GPU 调用。
- TypeScript executor 只能执行 Rust 已投影的 shape batch，并对 Image/Text 使用独立、
  有预算的 pass 输入；不保存另一个 Document、z-order 或 layout 事实来源。
- Image Pass 采用等价于 atlas 的有界按 AssetId texture cache：只保留当前帧可见且已验证的
  ImageBitmap，按 source identity/尺寸复用，资产离开当前图时立刻销毁 texture。统一资源准入
  先计算所有当前纹理字节；诊断记录纹理数、字节、命中、上传和释放，因而缓存不能无限增长。
- GPU Text atlas 最多四页。每页都是固定 1024² R8，资源准入在首个 glyph 上传前预留
  整个页集；页满时只会在帧之间逐页 LRU 替换未被当前帧引用的页。若所有页都被当前帧
  使用，才以节点为单位明确 Canvas fallback，避免半 GPU/半 Canvas 重影。
- 真实 `device.lost` 首次触发时丢弃全部派生资源并从最新确认 revision 重建；第二次连续
  失败稳定转 Canvas。该过程不修改 Document、operation journal 或 document hash。

## 后果

这条路线避免在当前浏览器包中复制一套 Rust `wgpu` Surface/线程实现，同时仍把数据语义
放在 Rust。native executor 继续消费相同 Rust graph 与 instance layout，但它不是浏览器的
第二条主路径。任何新增浏览器 GPU pass 必须先扩展 Rust graph 契约，再增加 Worker
executor；不得直接从 React 或 Canvas projection 推导持久渲染顺序。

W4 验收需要为 WebGPU、Canvas fallback 与 Device Lost recovery 冻结同一 fixture 的
revision、document hash、资源统计、截图和 Golden manifest。浏览器 WebGPU validation/OOM/
upload failure 必须被记录为结构化 renderer diagnostics，不得静默重试或保持旧 device 的
handle。
