# ADR 0014：Engine Worker 有界恢复与安全模式

状态：已采纳（Phase 0 恢复基线）

## 决定

- Main Thread 监听 Engine Worker 的未处理 `error` 与 `messageerror`。首次异常会销毁该 Worker、重新挂载不可重复转移的 Canvas，并在短延迟后启动新 Worker。
- 重启优先使用 Main Thread 最近收到的已确认 `CoreLocalSnapshot`；该快照由 Rust/WASM 的 Canonical 状态生成。若内存中还没有确认快照，新 Worker 继续走 IndexedDB/OPFS 的 active/previous Manifest 恢复路径。
- 连续第二次异常不再无限重启，而是停止 Worker、禁用编辑命令并显示安全模式提示。只有 Worker 已稳定运行五秒并再次发布确认快照后，才清除连续失败计数。
- Worker 重启不向 Canonical Document 写入合成修复操作；未确认中的输入不会被当作已提交内容恢复。
- 开发环境可在固定 `phase0-basic-card` Fixture 上传入 `simulateWorkerCrash=1` 或 `=2`。主线程只会在收到确认的 `CoreLocalSnapshot` 后才请求一次受控的未处理 Worker 异常；一次用于验证从确认快照恢复，两次用于验证安全模式。参数限制为 0–2，生产构建与其他 URL 忽略它。

## 后果

这一基线将 Engine 崩溃限制在“最多一次自动恢复或显式安全模式”，并保护最新确认状态不被崩溃循环覆盖。它不替代服务端 pending Operation Ack、跨浏览器协同、下载诊断包或真正的 GPU 资源重建；后续后端仍需在相同确认边界上补齐这些能力。
