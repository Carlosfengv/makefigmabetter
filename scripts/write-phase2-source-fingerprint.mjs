#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const workspaceRoot = dirname(dirname(fileURLToPath(import.meta.url)));

function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
function git(root, args) {
  // A dirty Phase 2 workspace can contain generated WASM and fixtures, so its
  // binary patch can exceed Node's 1 MiB default output buffer.
  try { return execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { return undefined; }
}

/** Records the exact Phase 2 files that make a browser candidate meaningful. */
export function phase2SourceFingerprint({ paths, root = workspaceRoot, capturedAt = new Date().toISOString() }) {
  const sourceFiles = paths.map((path) => {
    const absolutePath = resolve(root, path);
    return existsSync(absolutePath) ? { path: relative(root, absolutePath), sha256: sha256(readFileSync(absolutePath)) } : { path, missing: true };
  });
  const trackedPatch = git(root, ["diff", "--no-ext-diff", "--binary", "HEAD"]);
  const status = git(root, ["status", "--short"]);
  return {
    format: "makefigma-phase2-source-fingerprint-v1",
    capturedAt,
    repository: {
      head: git(root, ["rev-parse", "HEAD"]) ?? "unavailable",
      trackedPatchSha256: trackedPatch === undefined ? "unavailable" : sha256(trackedPatch),
      statusSha256: status === undefined ? "unavailable" : sha256(status),
    },
    sourceFiles,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [evidenceDirectory, ...paths] = process.argv.slice(2);
  if (!evidenceDirectory || paths.length === 0) {
    console.error("Usage: write-phase2-source-fingerprint.mjs <evidence-directory> <source-path> [...source-path]");
    process.exitCode = 64;
  } else {
    const output = resolve(evidenceDirectory, "source-fingerprint.json");
    writeFileSync(output, `${JSON.stringify(phase2SourceFingerprint({ paths }), null, 2)}\n`);
    console.log(output);
  }
}
