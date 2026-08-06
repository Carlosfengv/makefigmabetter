#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const fixturePath = "fixtures/documents/phase2-common-nodes.fixture.json";
const manifestPath = "verification/phase2/common-nodes-fixture-manifest.json";

export function phase2CommonNodesEvidence({ evidenceDirectory, evidenceUrl, capturedAt = new Date().toISOString() }) {
  const artifact = (path) => existsSync(resolve(root, path)) ? { path, sha256: sha256(readFileSync(resolve(root, path))) } : undefined;
  const artifacts = readdirSync(evidenceDirectory)
    .filter((name) => /^(?:open|resize|snapshot|readiness|performance-warmup|screenshot-(?:start|end)|cycles|stability-summary)(?:-|\.)|^performance-run-\d+\.txt$|^(phase2-common-nodes(?:-(?:start|end))?\.png|screenshot\.log|console\.txt|browser-environment\.txt|performance-summary\.json)$/.test(name))
    .map((name) => artifact(relative(root, resolve(evidenceDirectory, name))))
    .filter(Boolean);
  return {
    format: "makefigma-phase2-common-nodes-evidence-v1",
    capturedAt,
    evidenceUrl,
    fixture: artifact(fixturePath),
    fixtureManifest: artifact(manifestPath),
    artifacts,
    ...(readEmbeddedJson(resolve(evidenceDirectory, "browser-environment.txt")) ? { browserEnvironment: readEmbeddedJson(resolve(evidenceDirectory, "browser-environment.txt")) } : {}),
    golden: {
      status: "pending-independent-review",
      candidatePolicy: {
        comparison: "rgba-pixel-diff",
        maximumChannelDelta: 2,
        maximumDifferingPixelRatio: 0.005,
        allowedDifferenceRegions: [],
        requiresReviewerFreeze: true,
      },
    },
  };
}

function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function readEmbeddedJson(path) {
  if (!existsSync(path)) return undefined;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/).map((value) => value.trim())) {
    if (!line) continue;
    try {
      const decoded = JSON.parse(line);
      const value = typeof decoded === "string" ? JSON.parse(decoded) : decoded;
      if (value && typeof value === "object") return value;
    } catch { /* Playwright may prefix output with a heading. */ }
  }
  return undefined;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [evidenceDirectory, evidenceUrl] = process.argv.slice(2);
  if (!evidenceDirectory || !evidenceUrl) {
    console.error("Usage: node scripts/write-phase2-common-nodes-evidence.mjs <evidence-directory> <evidence-url>");
    process.exit(64);
  }
  const output = resolve(evidenceDirectory, "evidence-metadata.json");
  writeFileSync(output, `${JSON.stringify(phase2CommonNodesEvidence({ evidenceDirectory: resolve(evidenceDirectory), evidenceUrl }), null, 2)}\n`);
  console.log(output);
}
