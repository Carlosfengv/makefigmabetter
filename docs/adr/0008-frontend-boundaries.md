# ADR 0008：前端目录、Primitive 与部署边界

状态：已采纳（Phase 0 基线）

## 决定

- Web 端固定采用 Next.js App Router；禁止 `src/pages` 与承载业务的 `src/app/api`。浏览器编辑器只通过 Worker/WASM 与本地持久化交互，不承担后端 API 职责。
- `src/components/ui` 是唯一可直接使用 Base UI 的 Primitive 层；业务组件必须从 `@/components/ui/*` 组合，不能直接引入 Base UI、Radix、React Aria、MUI 或 Ant Design。
- `components.json` 固定 `base-nova`（shadcn Base UI）、RSC、TSX、CSS Variables 和别名；新增 UI 依赖必须先更新 ADR 与 allowlist。`components/ui` 至少有一个本地 Primitive 直接依赖 `@base-ui/react/*`，业务层仍只能从该本地目录组合，不能直接导入 Base UI。
- `components/ui` 不得依赖 Worker、持久化、事务、诊断或性能模块，保证 Primitive 可独立复用。

## 执行

`verification/phase0/0.14/shadcn-info-baseline.json` 保存通过 shadcn CLI 获取的离线配置基线；CI 不联网运行 `@latest`，而由 `pnpm check:boundaries` 对照该基线扫描 App Router、所有 Next Route Handler、`components.json` 的 Base UI 配置、导入边界、package 依赖和 Web 对独立 Backend 的反向导入。ESLint 同时禁止业务代码直接导入第三方 UI 基座。该检查应成为 CI 的必经步骤。

## 后果

`services/mock-backend` 是一个不依赖 Next 的独立 Node 进程，当前只暴露无状态的 `GET /health` 与 `GET /contracts/v1/editor`。`pnpm mock:backend` 可单独启动，`pnpm mock:backend:check` 会在临时端口实际请求这两个端点；它不包含业务写入、认证或 Document 状态，不能被误认为生产后端。未来出现第二个前端应用前，不提前复制 `components/ui`；需要共享时必须通过 ADR 迁移整个 Primitive 层，不能维持两份实现。
