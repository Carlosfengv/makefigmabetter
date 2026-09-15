#!/usr/bin/env node

import { remediationEvidenceViolations } from "./remediation-evidence.mjs";

const violations = remediationEvidenceViolations();
if (violations.length) {
  console.error(`Remediation evidence check failed:\n${violations.map((message) => `- ${message}`).join("\n")}`);
  process.exitCode = 1;
} else {
  console.log("Versioned remediation completion records verified.");
}
