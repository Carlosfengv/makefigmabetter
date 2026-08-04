#!/usr/bin/env node

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { collectPhase0EvidenceMetadata } from "./phase0-evidence-metadata.mjs";

const [evidenceDirectory, evidenceUrl] = process.argv.slice(2);
if (!evidenceDirectory || !evidenceUrl) {
  console.error("Usage: write-phase0-evidence-metadata.mjs <evidence-directory> <evidence-url>");
  process.exit(64);
}
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const directory = resolve(evidenceDirectory);
mkdirSync(directory, { recursive: true });
const metadata = collectPhase0EvidenceMetadata({ root, evidenceDirectory: directory, evidenceUrl });
writeFileSync(resolve(directory, "evidence-metadata.json"), `${JSON.stringify(metadata, null, 2)}\n`);
console.log(`Phase 0 evidence metadata written to ${resolve(directory, "evidence-metadata.json")}`);
