# Phase 2 R0：可复现集成基线记录

- 日期：2026-08-16
- 状态：候选；待提交为冻结源码后在 CI 再次执行。
- 候选源码：当前工作区的 R0 修复（WASM 可复现构建），以 `main` 的 `6ccc51d3b212e95a600790951159fb3402aa89ef` 为父基线。

## 已解决的生成物漂移

`editor_wasm_bg.wasm` 曾把绝对工作区路径写入 Rust 断言消息；因此相同源码在不同 clone 路径下会产生不同二进制，违反 R0 的生成物一致性要求。`scripts/build-wasm.sh` 现将工作区与 Cargo 缓存根映射为稳定前缀，并让 CI 与 README 使用与 `Cargo.lock` 相同的 `wasm-bindgen-cli 0.2.126`。

在 `/Users/carlos/Downloads/makefigma` 与 `/tmp/makefigma-r0-6ccc51d` 两个不同路径的 worktree 重建后，`src/wasm/generated/editor_wasm_bg.wasm` SHA-256 均为：

```text
5ec5c218a718e1cc8545bf633cac4f4bba83f3f492d2dfa487b41a99f97b3285
```

## 已通过的候选检查

- `pnpm check:boundaries`、`pnpm check:compatibility`、`pnpm lint`
- `pnpm test`：159 个文件、708 项测试
- `pnpm build`
- `pnpm protocol:check`
- `pnpm wasm:build`（跨 worktree 字节一致）
- `cargo test --workspace`
- `cargo test -p makefigma-renderer-wgpu --features native-wgpu-executor`
- `pnpm document:api:check`、`pnpm asset:api:check`、`pnpm workspace:api:check`、`pnpm mock:backend:check`
- `pnpm check:phase1-snapshot-fixtures`、`pnpm check:phase2-common-nodes-fixture`

## 冻结前待办

1. 将 R0 修复提交，记录最终 commit SHA；不得将本机 `next-env.d.ts` 变动或未跟踪截图纳入该提交。
2. 在全新 CI runner 运行同一套 jobs，确认生成物检查没有未解释差异。
3. 将 CI job URL、最终 `git status --short`、fixture/manifest SHA-256 与 R2 独立签署一并追加至 [Phase 2 完成清单](completion-checklist.md)。
