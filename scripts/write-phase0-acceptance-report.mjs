#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function valueOrUnknown(value) {
  return value === undefined || value === null || value === "" ? "未记录" : String(value);
}

function automaticResult(verification) {
  if (verification.status === "pass") return "自动校验 PASS；待独立验收人签收";
  if (verification.status === "pending") return "BLOCKED：等待独立验收人冻结 Golden 基线";
  return `FAIL：${valueOrUnknown(verification.reason)}`;
}

function performanceDescription(performance) {
  if (!performance || performance.status !== "pass") return "未采集性能摘要；正式基准必须预热 30 秒并至少运行三次";
  const median = performance.median ?? {};
  return `${performance.runs.length} 次受控渲染采样；每次 ${performance.samplesPerRun} 个样本；中位 P50 ${median.p50Ms}ms、P95 ${median.p95Ms}ms、最大值 ${median.maxMs}ms；预热 ${performance.warmupSeconds}s`;
}

/** Renders the machine-verifiable part of the Phase 0.11 acceptance record. */
export function renderPhase0AcceptanceReport({ metadata, verification, evidenceDirectory, performance }) {
  const build = metadata.build ?? {};
  const wasm = build.wasmBinary;
  return `# Phase 0.11 验收报告\n\n| 字段 | 记录 |\n| --- | --- |\n| Phase / Step | Phase 0 / 0.11 |\n| Build | 应用 ${valueOrUnknown(build.applicationVersion)}；WASM semantics ${valueOrUnknown(build.engineSemanticsVersion)}；Core Snapshot schema ${valueOrUnknown(build.coreSnapshotSchemaVersion)}；WASM SHA-256 ${valueOrUnknown(wasm?.sha256)} |\n| Environment | Node ${valueOrUnknown(metadata.runtime?.node)}；${valueOrUnknown(metadata.runtime?.platform)}/${valueOrUnknown(metadata.runtime?.architecture)}；固定视口 ${valueOrUnknown(verification.viewport?.width)}×${valueOrUnknown(verification.viewport?.height)}，DPR ${valueOrUnknown(verification.viewport?.dpr)} |\n| Test Fixture | ${valueOrUnknown(metadata.fixture?.path)}；SHA-256 ${valueOrUnknown(metadata.fixture?.sha256)} |\n| Preconditions | ${valueOrUnknown(metadata.evidenceUrl)} |\n| Procedure | 由 \`scripts/capture-phase0-evidence.sh\` 采集固定 Fixture、截图、DOM 快照、控制台与浏览器运行时信息 |\n| Expected | Canvas 初始化；无未处理异常；截图与已审核 Golden 一致 |\n| Actual | Golden 状态：${valueOrUnknown(verification.status)}${verification.reason ? `（${verification.reason}）` : ""} |\n| Metrics | ${performanceDescription(performance)} |\n| Evidence | ${evidenceDirectory}/（metadata、PNG、日志、Golden 验证结果） |\n| Defects | 待验收人填写 |\n| Result | ${automaticResult(verification)} |\n| Sign-off | 验收人、日期：待填写 |\n\n## 自动生成信息\n\n- 采集时间：${valueOrUnknown(metadata.capturedAt)}\n- Golden 基线：${valueOrUnknown(verification.baseline)}\n- Golden 基线 SHA-256：${valueOrUnknown(verification.baselineSha256)}\n- 当前截图 SHA-256：${valueOrUnknown(verification.captureSha256)}\n- Golden manifest：${valueOrUnknown(metadata.goldenManifest?.path)}；SHA-256 ${valueOrUnknown(metadata.goldenManifest?.sha256)}\n`;
}

function parseArgs(args) {
  if (args.length < 1 || args.length > 2) return undefined;
  return { evidenceDirectory: args[0], outputPath: args[1] };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  if (!args) {
    console.error("Usage: write-phase0-acceptance-report.mjs <evidence-directory> [output.md]");
    process.exitCode = 64;
  } else {
    const evidenceDirectory = resolve(args.evidenceDirectory);
    const metadataPath = resolve(evidenceDirectory, "evidence-metadata.json");
    const verificationPath = resolve(evidenceDirectory, "golden-verification.json");
    if (!existsSync(metadataPath) || !existsSync(verificationPath)) {
      console.error("Evidence directory must contain evidence-metadata.json and golden-verification.json.");
      process.exitCode = 1;
    } else {
      const outputPath = resolve(args.outputPath ?? resolve(evidenceDirectory, "acceptance-report.md"));
      const performancePath = resolve(evidenceDirectory, "performance-summary.json");
      writeFileSync(outputPath, renderPhase0AcceptanceReport({
        metadata: readJson(metadataPath), verification: readJson(verificationPath), evidenceDirectory: args.evidenceDirectory,
        performance: existsSync(performancePath) ? readJson(performancePath) : undefined,
      }));
      console.log(`Phase 0.11 acceptance report written to ${outputPath}`);
    }
  }
}
