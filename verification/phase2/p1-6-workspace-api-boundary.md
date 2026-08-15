# Phase 2 P1-6 验收记录：workspace Route Handler 迁出前端独立部署边界

- 日期：2026-08-07
- 计划条目：`docs/phase2-remediation-plan.md` P1-6
- 状态：已完成。`pnpm check:boundaries` 通过，边界规则**未放宽**。

## 问题

`src/app/api/workspaces/[workspaceKey]/route.ts` 是一个 Next Route Handler，承载工作区目录的业务读写 API，违反「业务 API 位于独立后端、web 与后端可各自独立部署」的边界规则。`scripts/check-frontend-boundaries.mjs` 对 `src/app/api` 目录与任何 `app/**/route.ts` 直接判失败。

## 方案

采纳「迁入 `services/`」（与既有 `mock-backend`、Rust `document-api`/`asset-api` 同级的独立进程），**不**走豁免、**不**放宽检查。

## 交付物

1. **独立后端进程** `services/workspace-api/server.mjs`
   - `createWorkspaceBackend({ dataDir })` 返回 `node:http` server；工厂化以便测试注入临时数据目录。
   - 原 Route Handler 语义逐条搬移：`.local/workspace-catalog.json` 持久化、按 key 的 in-process 写序列化 `serializeWorkspaceWrite`、跨进程目录文件锁 `withCatalogLock`（含 30s stale 抢占与 5s 超时）、原子 `tmp`→`rename` 写、乐观并发（`if-match` 头对齐 `revision`，不匹配返回 409 + 当前目录）。
   - 契约端点：`GET /health`、`GET /v1/workspaces/:workspaceKey`、`PUT /v1/workspaces/:workspaceKey`；仅 `DEMO_WORKSPACE_KEY` 有效，其余 404。
   - 加固：请求体 8 MiB 上限（防内存耗尽），响应 `no-store` + `X-Content-Type-Options: nosniff`，未捕获异常统一 500。
   - `createSeedWorkspace` 与前端 `src/lib/workspace-store.ts` 的离线缓存 seed 保持一致，首个 GET 与客户端本地缓存对齐。

2. **前端改为同源代理消费** `src/lib/workspace-store.ts`
   - 新增 `workspaceApiUrl = process.env.NEXT_PUBLIC_WORKSPACE_API_URL ?? "/workspace-api"` 与 `workspaceEndpoint(key)`，与 document-api/asset-api 完全同构。
   - `queueWorkspaceSave` 与 `fetchWorkspace` 的 `fetch` 目标由 `/api/workspaces/...` 改为 `workspaceEndpoint(...)`；浏览器流量恒为同源，部署侧供给认证代理目标。

3. **Next 代理接线** `next.config.ts`
   - 新增 rewrite `{ source: "/workspace-api/:path*", destination: `${workspaceApiTarget}/:path*` }`，`workspaceApiTarget = process.env.MAKEFIGMA_WORKSPACE_API_TARGET ?? "http://127.0.0.1:8790"`。

4. **删除 Route Handler**
   - `git rm src/app/api/workspaces/[workspaceKey]/route.ts`；`src/app` 下已无 `api/` 目录、无任何 `route.ts`。

5. **运行/校验入口与 CI**
   - `package.json`：`workspace:api`（`node services/workspace-api/server.mjs`，默认 PORT 8790，`MAKEFIGMA_WORKSPACE_DATA_DIR` 可覆盖数据目录）、`workspace:api:check`。
   - `.github/workflows/verify.yml`：与 document-api / asset-api / mock-backend 并列跑 `pnpm workspace:api:check`。

## 测试

- `services/workspace-api/server.test.mjs`（7 例，临时数据目录端到端起真实 server）：
  1. `/health` no-store + 版本化契约；
  2. 首读返回 seed（revision 1）；
  3. `if-match:1` 写入递增到 revision 2 并持久化（复读一致）；
  4. stale `if-match:1` 二次写返回 409 + 当前目录（first/revision 2）；
  5. 未知 key GET/PUT 均 404；
  6. 畸形 body PUT 返回 400 `INVALID_WORKSPACE`；
  7. `POST /v1/workspaces` 无隐式写面 404。
- `services/workspace-api/check.mjs`：独立进程冒烟（健康 + seed 读 + if-match 写递增 + stale 409），临时目录，`pnpm workspace:api:check` 通过。
- 全套 `pnpm test`：130 文件 / 500 项全绿（含新增 7 例；迁移前 493）。
- `pnpm check:boundaries`：通过（228 源文件），**未放宽任何规则**。
- `src/lib/workspace-store.test.ts` 既有存队列/离线回退用例不受 URL 变更影响，继续全绿。
