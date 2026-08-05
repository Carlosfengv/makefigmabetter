# Phase 1.4：浏览器 HTTP Conflict 重放记录

状态：通过本次 Conflict 分支演练；不构成 Phase 1 完成声明。

## 环境

- 本地候选：未提交工作树，基线 `5c459da`；
- 浏览器：两个隔离的 Playwright Chromium 会话；
- Web：Next development server，通过同源 `/document-api` 代理；
- Document API：独立临时 SQLite 数据库，回环地址；
- Document：默认 starter Document，起始为 4 个节点。

## 场景与结果

1. 会话 A 创建 Rectangle，服务端接受，Document 为 5 个节点；
2. 会话 B 从服务端加载该 Snapshot，创建第二个 Rectangle，服务端为 6 个节点；
3. 未刷新会话 A，在旧 revision 上创建第三个 Rectangle，Document API 返回预期的
   `409 BaseRevisionConflict`；
4. A 获取服务端 Snapshot，保留原节点 ID，重新分配与 B 冲突的 Canonical
   `PositionId`，生成新的 Operation/Transaction ID 与 `baseRevision`；
5. 重放 Operation 被服务端接受。A 显示 `remote changes saved`，为 7 个节点；
6. 刷新 B 后，B 显示 `remote document loaded`，同样为 7 个节点。

HTTP `404`（首次根文档探测）和 `409`（本场景故意注入）会出现在浏览器网络控制台；它们是已处理的协议结果，不是未捕获的浏览器异常。

## 覆盖边界

该记录证明真实 Browser → Worker → IndexedDB pending → Document API 的 Conflict
分支会重放仍有效的 Create，并处理并发 PositionId 冲突。同步器单元测试另覆盖
Permanent Reject 会停止原顺序并保留服务端安全诊断；该分支尚未成为独立浏览器录制。
离线刷新、服务重启和最终 Canonical Hash 比对仍须作为独立 Phase 1.4 场景持续验证。

## Accepted Hash 对账采集器

`pnpm evidence:phase1-operation-hash` 在隔离的 Web、Document API 与浏览器会话中创建
一个真实 Rectangle，等待服务端 Ack，然后比较浏览器 Rust/WASM Core 暴露的
`documentId`、revision、Canonical Hash 与同一 Document API Snapshot 响应的受控 headers。
该采集器不在 TypeScript 中解码或重编码 Snapshot bytes；服务器以
`x-makefigma-document-revision` 和 `x-makefigma-document-hash` 提供只读证据元数据。

```sh
pnpm evidence:phase1-operation-hash \
  http://127.0.0.1:3000 \
  output/phase1-operation-hash/local-run
```

成功时会保存截图、浏览器控制台、原始 Hash 比较和 `operation-hash-summary.json`。
它覆盖单个已接受 Operation 的最终一致性；离线/刷新/服务重开组合仍按本节范围分别采集。

最近一次干净临时数据库演练已通过：创建后的浏览器与服务端均为 revision `5`，
Canonical Hash 为 `5b56d5791b44bdf25a3b5931eb1a264c83e03b98ffacde607b6c04bd85383fe7`，
控制台为 `0` errors。该演练还修正了本地单节点创建曾绕过已解析 Core Batch、从而
派生不同 `PositionId` 的缺陷；本地与服务端现在执行完全相同的 Batch。
