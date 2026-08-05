# Phase 1.11：30 分钟稳定性采集器

状态：本地 30 分钟隔离候选记录已完成；尚未取得独立验收。

scripts/capture-phase1-stability-evidence.sh 默认运行 1800 秒。它在同一浏览器会话中记录
baseline/final document hash、渲染诊断、性能、主线程 long task、截图与控制台；启动时还会触发
一次受控 GPU Device Lost 和 Engine Worker crash。只有在重启 Worker 返回确认快照后，持久的
data-engine-recoveries 计数才会增加；否则采集失败。初始动作包括创建并切换 Page、矩形创建、撤销/
重做、复制/删除、真实图片导入，以及真实 File 输入读取期间点击 Cancel import；同时包含 IME 草稿
输入后 Escape 取消。循环继续平移、缩放、创建、撤销/重做和复制/删除。

服务重启不是可选项。推荐使用采集器的隔离模式：它会编译并启动独立的 Document、Asset、Next 服务，
在半程停止并重启两个后端服务，再刷新同一浏览器会话。采集使用真实远程文档会话，不附加 fixture，
因此 Page 与编辑操作会经过 Document API：

~~~sh
MAKEFIGMA_STABILITY_ISOLATED=1 \
pnpm evidence:phase1-stability \
  ignored \
  output/playwright/phase1-stability/<build-id>
~~~

全新隔离数据库第一次读取默认文档会得到一次 HTTP 404，随后客户端立即创建该文档；采集器把这一条
已知 bootstrap 传输记录单独保留在 console.txt，并仍会拒绝所有其他控制台错误。

如果不使用隔离模式，运行者必须提供实际重启隔离 Document 与 Asset 服务的命令：

~~~sh
MAKEFIGMA_STABILITY_DOCUMENT_RESTART_COMMAND='...' \
MAKEFIGMA_STABILITY_ASSET_RESTART_COMMAND='...' \
pnpm evidence:phase1-stability \
  http://127.0.0.1:3013 \
  output/playwright/phase1-stability/<build-id>
~~~

缺少任一重启命令时，采集器在浏览器循环后写入 status=incomplete 并以退出码 2 结束；它不会生成
PASS 或 local-candidate。即使两个命令均成功，结果也只会是 local-candidate，仍需要独立环境、
缺陷审计与签字。

2026-08-05 的 0 秒完整接线冒烟写入
output/playwright/phase1-stability/wiring-smoke-full-loop/：页面达到 WebGPU scene recovered (1)、
Rust/WASM bridge ready、已从确认快照恢复；Page 创建/切换、创建/撤销/重做、复制/删除和 IME 草稿
取消均已执行，控制台为 0 errors，最后严格标记为 incomplete，原因是未配置隔离服务重启。该结果仅
证明采集链路接通，不是稳定性验收。

2026-08-05 的隔离恢复回归写入
output/playwright/phase1-stability/isolated-wiring-smoke-recovery-verified/：真实远程文档从 revision 0
推进到 revision 3；受控 GPU Device Lost 恢复，Engine Worker 的 data-engine-recoveries=1；Page 创建/
切换、编辑、IME 取消、循环操作均执行；Document 与 Asset 服务半程重启记录为 executed；最终控制台为
0 errors，summary 为 local-candidate。该记录仅持续 1 秒，用来验证采集器与恢复门槛，绝不能代替
所需 30 分钟候选记录或独立验收。

2026-08-05 的 30 分钟隔离候选记录写入
`output/phase1-stability/candidate-30min-duplicate-position-fix-20260805T1239Z/`：持续 1,800 秒，完成
51 个编辑循环，Document 与 Asset 服务中点重启记录为 `executed`。最终运行时诊断中没有
`ENGINE_*` 错误（除启动 `ENGINE_WORKER_READY` 外），控制台没有错误；受控 Worker 崩溃恢复次数为 1，
主线程 long task 为 0，渲染 P95 为 0.92 ms。该结果满足本地 30 分钟稳定性候选要求，但依然只是
`local-candidate`，不能替代独立环境、Golden 审核、P0/P1 审计及签字。
