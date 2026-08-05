# Phase 1.4：隔离浏览器恢复记录

状态：自动化恢复组合已覆盖；不是 Phase 1 完成声明。

## 环境

- 浏览器：Playwright Chromium，`http://127.0.0.1:3002`；
- Document API：`127.0.0.1:8878`，独立 SQLite；
- Asset API：`127.0.0.1:8879`，独立 SQLite；
- Web 同源代理：`/document-api` 和 `/asset-api`，避免把开发端口放进浏览器 CORS 信任边界。

## 执行与结果

1. 首次加载创建远端 Document；创建一个 Rectangle 后，状态为 `remote changes saved`；
2. 断网后再创建一个 Rectangle，状态为 `remote sync retrying`，本地显示 6 个节点；
3. 恢复网络但停止 Document API，刷新后本地仍显示 6 个节点；
4. 重启同一 SQLite 的 Document API，再次加载后状态为 `remote document loaded`，仍显示 6 个节点；
5. 服务端最终 revision 为 `2`，Canonical hash 为
   `288516fd665b86aa1418c3fd36274d6175ed01c09565344b8628299cbbf71fcf`；
   operation 表包含 revision 1 和 2，说明离线操作在服务恢复后被持久接受。

首次执行的最终页面无浏览器 console error。截图存于被忽略的本地证据路径
`output/playwright/phase1-w1-recovered.png`，SHA-256 为
`be19619fab8be57e280024cb2e958f31eecf1481b650946b9abe90681cfd25e0`。

## 复现

`pnpm evidence:phase1-operation-recovery` 是当前的可复现 Gate：它为每次运行创建新的
Playwright 会话和临时 SQLite 数据库，启动独立的 Document API 与 Web 服务，执行已接受
操作、断网操作、服务停机刷新、同一 SQLite 服务重启，并断言最终浏览器/服务端均为
revision `2` 且 Canonical Hash 相同。它会保存截图、原始 Hash 比较、控制台和
`operation-recovery-summary.json`；停服期间该默认 Document Snapshot 请求产生的受控
`404`/`500` 传输响应被作为场景预期，其他浏览器错误仍会失败。

```sh
pnpm evidence:phase1-operation-recovery \
  output/playwright/phase1-operation-recovery/<build-id>
```

## 2026-08-05：隔离构建目录与请求头验证

在共享开发服务器仍运行的情况下，以独立 Next 构建目录重新运行该 Gate。结果为 `pass`：
浏览器和服务端均为 revision `2`，Canonical Hash 同为
`cee692b9ef3ce4295ef5cb9d65f310890b93efa1dc632e89bb042a391a0e87ac`。

哈希探针现在只读取 `x-makefigma-document-revision`、`x-makefigma-document-hash` 和
`content-length` 响应头，并在 10 秒后中止；不会消耗 Snapshot 响应正文。重启窗口中的
五条 `500` 控制台记录来自预期的短暂 API 下线，脚本将其作为本场景的受控传输错误处理。
本次本地证据位于
`output/playwright/phase1-operation-recovery/header-only-final/`。

下面的手工步骤保留为环境/服务配置的排查参考：

以独立目录和端口启动两个 API，再构建并启动独立 Next 输出目录：

```sh
MAKEFIGMA_DOCUMENT_API_ADDRESS=127.0.0.1:8878 \
MAKEFIGMA_DOCUMENT_API_DATABASE=/tmp/makefigma-w1/document.sqlite \
cargo run -p makefigma-document-api

MAKEFIGMA_ASSET_API_ADDRESS=127.0.0.1:8879 \
MAKEFIGMA_ASSET_API_DATABASE=/tmp/makefigma-w1/asset.sqlite \
cargo run -p makefigma-asset-api

MAKEFIGMA_NEXT_DIST_DIR=output/phase1-w1-next \
MAKEFIGMA_DOCUMENT_API_TARGET=http://127.0.0.1:8878 \
MAKEFIGMA_ASSET_API_TARGET=http://127.0.0.1:8879 \
pnpm build
```
