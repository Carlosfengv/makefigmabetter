import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const compatibilityStates = new Set(["Supported", "Partial", "Later", "Unsupported", "N/A"]);
const requiredCapabilities = [
  "Frame / Rectangle / Ellipse / Text",
  "Text 内容与排版",
  "无限画布、平移与缩放",
  "命令、Operation、幂等与 Undo/Redo",
  "WebGPU / WebGL2",
  "色彩空间、alpha 与渐变插值",
  "对象级 AuthZ 与不可信资源",
];

/** Validates the Phase 0 compatibility matrix without inferring implementation status. */
export function compatibilityMatrixViolations(root) {
  const path = join(root, "docs", "compatibility-matrix.md");
  if (!existsSync(path)) return ["docs/compatibility-matrix.md must be present."];
  const rows = readFileSync(path, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("|") && !line.includes("---"))
    .map((line) => line.split("|").slice(1, -1).map((cell) => cell.trim()));
  const dataRows = rows.filter((row) => row[0] !== "能力");
  const violations = [];
  if (!dataRows.length) violations.push("compatibility matrix must contain capability rows.");
  for (const row of dataRows) {
    if (row.length !== 6) { violations.push(`compatibility matrix row must contain six cells: ${row.join(" | ")}`); continue; }
    const [capability, ...rest] = row;
    if (!capability) violations.push("compatibility matrix capability name must not be empty.");
    for (const [index, value] of rest.slice(0, 4).entries()) {
      if (!compatibilityStates.has(value)) violations.push(`${capability}: compatibility column ${index + 1} must be Supported, Partial, Later, Unsupported, or N/A.`);
    }
    if (!rest[4] || /^todo$/i.test(rest[4])) violations.push(`${capability}: current status must describe the implemented boundary or limitation.`);
  }
  for (const capability of requiredCapabilities) {
    if (!dataRows.some((row) => row[0] === capability)) violations.push(`compatibility matrix must track ${capability}.`);
  }
  return violations;
}
