# ADR 0015：视口裁剪空间索引评估

状态：已采纳（Worker fixed grid，后续阶段）

## 背景

50K fixture 的线性 AABB 裁剪在目标浏览器实测 P95 约为 3.3ms，超过优化方案定义的 2ms 门槛。旋转包围盒已作为 Worker 派生缓存，仍未达标。

## 决定

比较 Rust Core/Scene R-tree 或 BVH、Worker packed R-tree 与固定网格后，采纳 Worker fixed grid：它不穿越 WASM 边界、可在 hydrate/undo/redo/编辑投影时整体重建、保留 document index 以恢复 z-order，并将跨越过多格子的超大节点放入独立 side list。常规 50K 缩放实测 culling P95 已从约 3.3ms 降至 1.11ms。

## 不变量

- 索引只是可重建的 Worker 派生状态，不能进入 Canonical Document 或本地持久化；
- 查询必须维持原始 document z-order；
- hidden、locked、opacity、selection 和 hover 的行为不得因索引改变；
- 只有新实现将目标设备 culling P95 降至 2ms 以下，才替换当前线性实现。

## 后续动态 DPR

固定网格使 Worker 的裁剪 P95 降到目标以内，但目标浏览器的帧间隔仍高于最终 20ms 目标，因此启用仅限输入期间的动态 DPR。它不改变文档、命中测试或 Worker 的世界坐标：wheel 批次和手型平移先按缩放值选择渲染桶，然后以更小的 backing-store 进行临时绘制；最后一次输入 160ms 后，恢复设备原生 DPR 并补绘。

桶采用滞回，避免靠近边界时重复重分配：远景进入/离开阈值为 42%/58%，近景为 108%/92%；交互 DPR 系数为远景 0.65、常规和近景 0.75。静止状态始终是原生 DPR。该策略只在基础 culling、批量输入和 GPU 场景缓存已实施后启用。生产构建的 50K Canvas 2D 回归显示交互时 backing-store 会下降、静止后恢复原生尺寸；DPR 1/2 组合由三轮自动化证据采集验证。
