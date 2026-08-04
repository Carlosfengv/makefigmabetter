import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { compatibilityMatrixViolations } from "./compatibility-matrix.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const violations = compatibilityMatrixViolations(root);
if (violations.length) {
  console.error("Compatibility matrix check failed:\n" + violations.map((message) => `- ${message}`).join("\n"));
  process.exit(1);
}
console.log("Phase 0 compatibility matrix verified.");
