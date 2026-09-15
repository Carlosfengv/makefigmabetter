#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const root = dirname(scriptDirectory);
const sourcePath = resolve(root, "src/lib/node-capabilities.ts");
const outputPath = resolve(root, "docs/generated/node-capabilities.md");
const surfaces = ["read", "write", "render", "hit", "export", "import", "runtime"];
const statusLabel = { supported: "Supported", partial: "Partial", preserved: "Preserved", rejected: "Rejected" };
const behaviorTestPattern = /\.test\.(?:[cm]?[jt]sx?)$/;
const remediationRecordPattern = /^verification\/remediation\/[^/]+\/[^/]+\.json$/;

export async function buildNodeCapabilityDocument() {
  const source = readFileSync(sourcePath, "utf8");
  const transpiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    fileName: sourcePath,
  }).outputText;
  const sourceUrl = `${pathToFileURL(sourcePath).href}?sha256=${sha256(source)}`;
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(`${transpiled}\n//# sourceURL=${sourceUrl}`).toString("base64")}`;
  const { NODE_KIND_CAPABILITIES } = await import(moduleUrl);
  const violations = validateRegistry(NODE_KIND_CAPABILITIES);
  if (violations.length) return { content: "", violations };

  const lines = [
    "# 节点能力表（自动生成）",
    "",
    "> 来源：`src/lib/node-capabilities.ts`。请勿手工编辑；运行 `pnpm generate:node-capabilities` 更新。",
    `> Registry SHA-256：\`${sha256(source)}\`。`,
    "",
    "状态描述当前已验证边界。`Supported` 表示该入口在表内声明的子集有行为证据；`Partial`、`Preserved` 和 `Rejected` 的限制以 registry 文案为准。",
    "",
    "| NodeKind | Children | Paint | Clip | Text | Path | Layout | Mask | Inspector | Read | Write | Render | Hit | Export | Import | Runtime |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const [kind, capability] of Object.entries(NODE_KIND_CAPABILITIES)) {
    lines.push(`| \`${kind}\` | ${capability.childPolicy} | ${paintLabel(capability.ownPaint)} | ${yesNo(capability.childClip)} | ${yesNo(capability.text)} | ${yesNo(capability.path)} | ${yesNo(capability.autoLayout)} | ${yesNo(capability.maskEligible)} | ${enabledInspectorProperties(capability.inspector)} | ${surfaceLabel(capability.entrySupport.read)} | ${surfaceLabel(capability.entrySupport.write)} | ${surfaceLabel(capability.entrySupport.render)} | ${surfaceLabel(capability.entrySupport.hit)} | ${surfaceLabel(capability.entrySupport.export)} | ${surfaceLabel(capability.entrySupport.import)} | ${surfaceLabel(capability.entrySupport.runtime)} |`);
  }
  lines.push("", "## 入口限制与证据", "");
  for (const [kind, capability] of Object.entries(NODE_KIND_CAPABILITIES)) {
    lines.push(`### \`${kind}\``, "");
    for (const surface of surfaces) {
      const support = capability.entrySupport[surface];
      const evidence = support.evidence.map(markdownLink).join("、");
      lines.push(`- **${surface} · ${statusLabel[support.status]}**：${support.limitation} 证据：${evidence}。`);
    }
    lines.push("");
  }
  return { content: `${lines.join("\n").trimEnd()}\n`, violations: [] };
}

export function validateRegistry(registry) {
  const violations = [];
  const kinds = Object.entries(registry);
  if (kinds.length !== 36) violations.push(`expected 36 NodeKind rows, found ${kinds.length}`);
  for (const [kind, capability] of kinds) {
    for (const surface of surfaces) {
      const support = capability.entrySupport?.[surface];
      if (!support) { violations.push(`${kind}.${surface}: missing entry support`); continue; }
      if (!support.limitation?.trim()) violations.push(`${kind}.${surface}: missing limitation`);
      if (support.status === "supported" && !support.evidence?.length) violations.push(`${kind}.${surface}: Supported requires behavior evidence`);
      if (support.status === "supported" && !(support.evidence ?? []).some(isEligibleBehaviorEvidence)) {
        violations.push(`${kind}.${surface}: Supported requires a test or versioned remediation evidence record`);
      }
      for (const evidence of support.evidence ?? []) {
        if (evidence.startsWith("/") || evidence.includes("..")) violations.push(`${kind}.${surface}: evidence must be repository-relative (${evidence})`);
        else if (!existsSync(resolve(root, evidence))) violations.push(`${kind}.${surface}: evidence does not exist (${evidence})`);
      }
    }
  }
  return violations;
}

function isEligibleBehaviorEvidence(path) {
  if (behaviorTestPattern.test(path)) return true;
  if (!remediationRecordPattern.test(path)) return false;
  try {
    const record = JSON.parse(readFileSync(resolve(root, path), "utf8"));
    return record?.completionRecordVersion === 1 && record.result === "passed";
  } catch {
    return false;
  }
}

function surfaceLabel(support) {
  return statusLabel[support.status];
}

function paintLabel(paint) {
  if (paint.fill && paint.stroke) return "fill+stroke";
  if (paint.fill) return "fill";
  if (paint.stroke) return "stroke";
  return "none";
}

function yesNo(value) { return value ? "yes" : "no"; }
function enabledInspectorProperties(properties) {
  const enabled = Object.entries(properties).filter(([, value]) => value).map(([property]) => property);
  return enabled.length ? enabled.join(", ") : "none";
}
function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
function markdownLink(path) {
  const target = relative(dirname(outputPath), resolve(root, path)).replaceAll("\\", "/");
  return `[\`${path}\`](${target})`;
}

async function main() {
  const { content, violations } = await buildNodeCapabilityDocument();
  if (violations.length) {
    console.error(`Node capability registry check failed:\n${violations.map((item) => `- ${item}`).join("\n")}`);
    process.exitCode = 1;
    return;
  }
  if (process.argv.includes("--write")) {
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, content);
    console.log(`Generated ${relative(root, outputPath)}.`);
    return;
  }
  if (!existsSync(outputPath) || readFileSync(outputPath, "utf8") !== content) {
    console.error("Generated node capability documentation is stale. Run `pnpm generate:node-capabilities`.");
    process.exitCode = 1;
    return;
  }
  console.log("Node capability registry and generated documentation verified across 36 NodeKind rows.");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
