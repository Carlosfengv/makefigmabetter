import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const defaultDirectory = resolve(root, "verification/remediation");
const sha256Pattern = /^[a-f0-9]{64}$/;
const commitPattern = /^[a-f0-9]{40}$/;

export function completionRecordViolations(record, file = "record.json") {
  if (record?.completionRecordVersion !== 1) return [];
  const violations = [];
  const requireText = (value, field) => {
    if (typeof value !== "string" || !value.trim()) violations.push(`${file}: ${field} must be non-empty text`);
  };
  requireText(record.gate, "gate");
  requireText(record.capturedAt, "capturedAt");
  if (!commitPattern.test(record.sourceCommit ?? "")) violations.push(`${file}: sourceCommit must be a full 40-character Git commit`);
  if (record.workspaceDiff?.status !== "clean" && record.workspaceDiff?.status !== "dirty") violations.push(`${file}: workspaceDiff.status must be clean or dirty`);
  if (!Array.isArray(record.workspaceDiff?.paths) || (record.workspaceDiff?.status === "dirty" && record.workspaceDiff.paths.length === 0)) violations.push(`${file}: a dirty workspaceDiff requires changed paths`);
  requireText(record.environment?.browser, "environment.browser");
  requireText(record.environment?.device, "environment.device");
  if (!Array.isArray(record.commands) || record.commands.length === 0 || record.commands.some((command) => typeof command !== "string" || !command.trim())) violations.push(`${file}: commands must list executed verification commands`);
  if (record.result !== "passed" && record.result !== "failed") violations.push(`${file}: result must be passed or failed`);
  requireText(record.artifacts?.fixture?.path, "artifacts.fixture.path");
  if (!record.artifacts?.fixture || !sha256Pattern.test(record.artifacts.fixture.sha256 ?? "")) violations.push(`${file}: artifacts.fixture requires a SHA-256`);
  if (!record.sourceSha256 || Object.keys(record.sourceSha256).length === 0 || Object.values(record.sourceSha256).some((hash) => !sha256Pattern.test(hash))) violations.push(`${file}: sourceSha256 must contain valid hashes`);
  if (!Array.isArray(record.knownPartial)) violations.push(`${file}: knownPartial must be an array`);
  if (!Array.isArray(record.fallback) || record.fallback.length === 0) violations.push(`${file}: fallback must describe at least one safe fallback`);
  if (!Number.isSafeInteger(record.schema?.semanticsVersion) || !Number.isSafeInteger(record.schema?.localSnapshotVersion)) violations.push(`${file}: schema must include integer semanticsVersion and localSnapshotVersion`);
  requireText(record.schema?.versionChange, "schema.versionChange");
  return violations;
}

export function completionRecordIntegrityViolations(record, file = "record.json", repositoryRoot = root) {
  if (record?.completionRecordVersion !== 1) return [];
  const violations = [];
  const verify = (relativePath, expected, field) => {
    if (typeof relativePath !== "string" || !relativePath.trim()) return;
    if (!sha256Pattern.test(expected ?? "")) return;
    const path = resolve(repositoryRoot, relativePath);
    const rootPrefix = repositoryRoot.endsWith(sep) ? repositoryRoot : `${repositoryRoot}${sep}`;
    if (isAbsolute(relativePath) || (path !== repositoryRoot && !path.startsWith(rootPrefix))) {
      violations.push(`${file}: ${field} must stay inside the repository`);
      return;
    }
    if (!existsSync(path)) {
      violations.push(`${file}: ${field} does not exist (${relativePath})`);
      return;
    }
    const actual = createHash("sha256").update(readFileSync(path)).digest("hex");
    if (actual !== expected) violations.push(`${file}: ${field} SHA-256 mismatch (${relativePath})`);
  };
  for (const [path, hash] of Object.entries(record.sourceSha256 ?? {})) verify(path, hash, `sourceSha256.${path}`);
  verify(record.artifacts?.fixture?.path, record.artifacts?.fixture?.sha256, "artifacts.fixture");
  return violations;
}

export function remediationEvidenceViolations(directory = defaultDirectory, repositoryRoot = root) {
  if (!existsSync(directory)) return [`${relative(root, directory)}: evidence directory does not exist`];
  const entries = readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name));
  const directJsonFiles = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => resolve(directory, entry.name));
  const datedJsonFiles = entries
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => readdirSync(resolve(directory, entry.name), { withFileTypes: true })
      .filter((child) => child.isFile() && child.name.endsWith(".json"))
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((child) => resolve(directory, entry.name, child.name)));
  return [...directJsonFiles, ...datedJsonFiles]
    .flatMap((path) => {
      try {
        const record = JSON.parse(readFileSync(path, "utf8"));
        const displayPath = relative(root, path);
        return [
          ...completionRecordViolations(record, displayPath),
          ...completionRecordIntegrityViolations(record, displayPath, repositoryRoot),
        ];
      }
      catch (error) { return [`${relative(root, path)}: invalid JSON (${error instanceof Error ? error.message : "unknown error"})`]; }
    });
}
