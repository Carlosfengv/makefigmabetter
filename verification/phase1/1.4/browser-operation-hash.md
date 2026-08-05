# Phase 1.4：浏览器与 Document API Hash 对账

状态：局部浏览器 E2E 已通过；不是 W1 或 Phase 1 的完成声明。

`scripts/capture-phase1-operation-hash-evidence.sh` 在真实浏览器中创建一个 Rectangle，等待
Document API 接受 Operation，然后只比较浏览器 Rust/WASM 已公布的 revision/hash 与同一服务端
Snapshot 响应的 `x-makefigma-document-revision`、`x-makefigma-document-hash`。脚本不在
TypeScript 中解码第二份 Protobuf Snapshot。

服务端 response body 的消费不是该对账的证据条件：页面加载已经消费 Snapshot；采集只需权威响应头，
并使用 10 秒 AbortController 边界避免一次异常网络响应无限占用浏览器会话。

## 最近本地演练

在完整本地栈（页面 `127.0.0.1:3013`、Document API `127.0.0.1:8788`）中，2026-08-05 的演练得到：

- 浏览器 revision：203；
- 服务 revision：203；
- 两端 Canonical hash：`6012150b229db1e11abf728901d24b59f8f2a2ba53f38ae11e0f2c66a47461e1`；
- 浏览器控制台：0 errors。

产物位于 `output/playwright/phase1-operation-hash/header-only/`，其中
`operation-hash-summary.json` 为 `pass`。该结果来自 dirty 开发工作树，只可作为可重复的候选观察，
不能代替 commit-bound 验收、离线/刷新/冲突/服务重启矩阵或独立签字。

## 复现

```sh
pnpm evidence:phase1-operation-hash \
  http://127.0.0.1:3013 \
  output/playwright/phase1-operation-hash/<build-id>
```

运行前需要页面代理可访问本地 Document API；默认开发端口为 `8788`。
