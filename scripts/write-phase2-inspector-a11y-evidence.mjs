#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const fixturePath = "fixtures/documents/phase2-common-nodes.fixture.json";

/**
 * Metadata for the Phase 2 P1-2 screen-reader acceptance. Records the exact
 * polite live-region utterance the multi-select Inspector announced for a
 * hostile heterogeneous selection, plus the captured artifacts, so an
 * independent reviewer can confirm the Same / Mixed / NotApplicable tri-state is
 * conveyed non-visually and freeze the record.
 */
export function phase2InspectorA11yEvidence({ evidenceDirectory, evidenceUrl, announcement, capturedAt = new Date().toISOString() }) {
  const artifact = (path) => existsSync(resolve(root, path)) ? { path, sha256: sha256(readFileSync(resolve(root, path))) } : undefined;
  const artifacts = readdirSync(evidenceDirectory)
    .filter((name) => /^(open|resize|snapshot|readiness|selection-(?:snapshot|readiness|announcement)|select-(?:frame|text)|announcement-verdict|screenshot|console)\.(txt|log)$|^phase2-inspector-a11y\.png$/.test(name))
    .map((name) => artifact(relative(root, resolve(evidenceDirectory, name))))
    .filter(Boolean);
  return {
    format: "makefigma-phase2-inspector-a11y-evidence-v1",
    capturedAt,
    evidenceUrl,
    fixture: artifact(fixturePath),
    selection: {
      layers: ["Root Frame", "Fixture label"],
      kinds: ["frame", "text"],
      rationale: "A Frame with a Text is a hostile mix: Drop shadow is the sole shared editable control, Fill disagrees, and many specialized controls do not apply; the announcement must preserve all three states.",
    },
    liveRegion: {
      role: "status",
      ariaLive: "polite",
      announcement,
      source: "src/lib/inspector-capability-matrix.ts:inspectorCapabilityAnnouncement",
    },
    artifacts,
    signOff: {
      status: "pending-independent-review",
      requiresReviewerFreeze: true,
    },
  };
}

function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [evidenceDirectory, evidenceUrl, announcementJson] = process.argv.slice(2);
  if (!evidenceDirectory || !evidenceUrl) {
    console.error("Usage: node scripts/write-phase2-inspector-a11y-evidence.mjs <evidence-directory> <evidence-url> [announcement-json]");
    process.exit(64);
  }
  let announcement;
  try { announcement = announcementJson ? JSON.parse(announcementJson).announcement : undefined; } catch { announcement = announcementJson; }
  const output = resolve(evidenceDirectory, "evidence-metadata.json");
  writeFileSync(output, `${JSON.stringify(phase2InspectorA11yEvidence({ evidenceDirectory: resolve(evidenceDirectory), evidenceUrl, announcement }), null, 2)}\n`);
  console.log(output);
}
