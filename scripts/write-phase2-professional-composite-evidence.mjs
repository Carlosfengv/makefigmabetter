#!/usr/bin/env node

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { phase2Evidence } from "./write-phase2-common-nodes-evidence.mjs";

export function phase2ProfessionalCompositeEvidence({ evidenceDirectory, evidenceUrl, capturedAt = new Date().toISOString() }) {
  return phase2Evidence({
    format: "makefigma-phase2-professional-composite-evidence-v1",
    evidenceDirectory,
    evidenceUrl,
    fixturePaths: [
      "src/lib/phase2-professional-composite-fixture.ts",
      "src/lib/phase2-professional-composite-fixture.test.ts",
    ],
    artifactPattern: /^(?:open|resize|snapshot|readiness|performance-warmup|screenshot-(?:start|end)|cycles|stability-summary|stability-failure)(?:-|\.)|^(?:action|performance|memory)-run-\d+\.txt$|^move-verification-run-\d+\.txt$|^(phase2-professional-composite(?:-(?:start|end))?\.png|screenshot\.log|console\.txt|browser-environment\.txt|performance-summary\.json|memory-summary\.json|source-fingerprint\.json)$/,
    capturedAt,
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [evidenceDirectory, evidenceUrl] = process.argv.slice(2);
  if (!evidenceDirectory || !evidenceUrl) {
    console.error("Usage: node scripts/write-phase2-professional-composite-evidence.mjs <evidence-directory> <evidence-url>");
    process.exit(64);
  }
  const output = resolve(evidenceDirectory, "evidence-metadata.json");
  writeFileSync(output, `${JSON.stringify(phase2ProfessionalCompositeEvidence({ evidenceDirectory: resolve(evidenceDirectory), evidenceUrl }), null, 2)}\n`);
  console.log(output);
}
