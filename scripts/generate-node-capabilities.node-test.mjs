import assert from "node:assert/strict";
import test from "node:test";

import { validateRegistry } from "./generate-node-capabilities.mjs";

const surfaces = ["read", "write", "render", "hit", "export", "import", "runtime"];

function registryWithReadEvidence(evidence) {
  const partial = { status: "partial", limitation: "Explicit test fixture.", evidence: [] };
  const entrySupport = Object.fromEntries(surfaces.map((surface) => [surface, partial]));
  return Object.fromEntries(Array.from({ length: 36 }, (_, index) => [
    `kind-${index}`,
    {
      entrySupport: index === 0
        ? { ...entrySupport, read: { status: "supported", limitation: "Verified read behavior.", evidence } }
        : entrySupport,
    },
  ]));
}

test("Supported capability rejects source-only evidence", () => {
  const violations = validateRegistry(registryWithReadEvidence(["src/lib/node-capabilities.ts"]));
  assert.ok(violations.includes("kind-0.read: Supported requires a test or versioned remediation evidence record"));
});

test("Supported capability accepts an existing behavior test", () => {
  const violations = validateRegistry(registryWithReadEvidence(["src/lib/node-capabilities.test.ts"]));
  assert.equal(violations.length, 0);
});

test("Supported capability rejects a raw remediation sample", () => {
  const violations = validateRegistry(registryWithReadEvidence(["verification/remediation/2026-09-13/w02-empty-paint-browser.json"]));
  assert.ok(violations.includes("kind-0.read: Supported requires a test or versioned remediation evidence record"));
});

test("Supported capability accepts a passed versioned remediation record", () => {
  const violations = validateRegistry(registryWithReadEvidence(["verification/remediation/2026-09-13/w14-evidence-integrity.json"]));
  assert.equal(violations.length, 0);
});
