#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const defaultManifest = "verification/phase2/common-nodes-fixture-manifest.json";
const expectedNodes = [
  ["Root Frame", "frame"],
  ["Rotated Frame", "frame"],
  ["Content Group", "group"],
  ["Asymmetric Card", "rectangle"],
  ["Donut Ellipse", "ellipse"],
  ["Outside Ellipse", "ellipse"],
  ["Independent-cap Arrow", "line"],
  ["Section", "section"],
  ["Fixture label", "text"],
  ["Rotated Export Slice", "slice"],
];

/** Validates the fixed Phase 2 browser evidence input before any Golden or
 * performance capture. The fixture hash turns accidental visual edits into an
 * explicit review instead of silently changing the evidence surface. */
export function verifyPhase2CommonNodesFixture({ manifestPath = defaultManifest, root = process.cwd() } = {}) {
  const absoluteManifest = resolve(root, manifestPath);
  let manifest;
  try { manifest = JSON.parse(readFileSync(absoluteManifest, "utf8")); } catch (error) { return failed("INVALID_MANIFEST", { manifestPath, message: messageFor(error) }); }
  if (manifest.format !== "makefigma-phase2-common-nodes-manifest-v1" || manifest.fixtureName !== "F-PHASE2-COMMON-NODES" || typeof manifest.fixture !== "string" || !isSha256(manifest.fixtureSha256)) return failed("INVALID_MANIFEST", { manifestPath });

  const fixturePath = resolve(root, manifest.fixture);
  if (!existsSync(fixturePath)) return failed("MISSING_FIXTURE", { fixture: manifest.fixture });
  const bytes = readFileSync(fixturePath);
  const fixtureSha256 = sha256(bytes);
  if (fixtureSha256 !== manifest.fixtureSha256) return failed("FIXTURE_HASH_MISMATCH", { fixture: manifest.fixture, expected: manifest.fixtureSha256, actual: fixtureSha256 });
  let fixture;
  try { fixture = JSON.parse(bytes.toString("utf8")); } catch (error) { return failed("INVALID_FIXTURE", { fixture: manifest.fixture, message: messageFor(error) }); }
  if (fixture.format !== "makefigma-phase2-common-nodes-fixture-v1" || fixture.name !== manifest.fixtureName || !validViewport(fixture.viewport) || !Array.isArray(fixture.nodes)) return failed("INVALID_FIXTURE", { fixture: manifest.fixture });
  if (JSON.stringify(fixture.nodes.map((node) => [node?.name, node?.kind])) !== JSON.stringify(expectedNodes)) return failed("INVALID_NODE_COMPOSITION", { fixture: manifest.fixture });

  const ids = new Set(fixture.nodes.map((node) => node.id));
  if (ids.size !== fixture.nodes.length || fixture.nodes.some((node) => typeof node.id !== "string" || (node.parentId !== undefined && !ids.has(node.parentId)))) return failed("INVALID_HIERARCHY", { fixture: manifest.fixture });
  const arrow = fixture.nodes.find((node) => node.name === "Independent-cap Arrow");
  if (!arrow || arrow.height !== 0 || arrow.strokeCapStart !== "square" || arrow.strokeCapEnd !== "arrowLines") return failed("INVALID_LINE_CASE", { fixture: manifest.fixture });
  const card = fixture.nodes.find((node) => node.name === "Asymmetric Card");
  if (!card || JSON.stringify(card.cornerRadii) !== JSON.stringify([18, 4, 26, 10]) || JSON.stringify(card.strokeWeights) !== JSON.stringify([2, 6, 3, 5])) return failed("INVALID_RECTANGLE_CASE", { fixture: manifest.fixture });
  const ellipse = fixture.nodes.find((node) => node.name === "Outside Ellipse");
  if (!ellipse || ellipse.arcData !== undefined || ellipse.strokeAlign !== "outside" || ellipse.strokeWidth !== 6) return failed("INVALID_ELLIPSE_STROKE_ALIGN_CASE", { fixture: manifest.fixture });
  const slice = fixture.nodes.find((node) => node.name === "Rotated Export Slice");
  if (!slice || slice.kind !== "slice" || slice.strokeWidth !== 0 || slice.fill !== "transparent" || slice.stroke !== "transparent" || !Number.isFinite(slice.rotation) || !slice.relativeTransform) return failed("INVALID_SLICE_CASE", { fixture: manifest.fixture });
  return { status: "pass", fixture: manifest.fixture, fixtureSha256, nodeCount: fixture.nodes.length };
}

function validViewport(value) { return value && [value.x, value.y, value.zoom].every(Number.isFinite) && value.zoom > 0; }
function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function isSha256(value) { return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value); }
function messageFor(error) { return error instanceof Error ? error.message : "unreadable"; }
function failed(reason, details) { return { status: "fail", reason, ...details }; }

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = verifyPhase2CommonNodesFixture();
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.status === "pass" ? 0 : 1;
}
