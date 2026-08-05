#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const defaultManifest = "verification/phase1/1.11/render-composite-fixture-manifest.json";
const expectedNodes = [
  ["Render card", "frame"],
  ["Image cover crop", "image"],
  ["Sun disc", "ellipse"],
  ["Gradient signal", "rectangle"],
  ["Composite headline", "text"],
];

export function verifyPhase1RenderCompositeFixture({ manifestPath = defaultManifest, root = process.cwd() } = {}) {
  const absoluteManifest = resolve(root, manifestPath);
  let manifest;
  try { manifest = JSON.parse(readFileSync(absoluteManifest, "utf8")); } catch (error) { return failed("INVALID_MANIFEST", { manifestPath, message: messageFor(error) }); }
  if (manifest.format !== "makefigma-phase1-render-composite-manifest-v1" || manifest.fixtureName !== "F-PHASE1-RENDER-COMPOSITE" || typeof manifest.fixture !== "string" || !isSha256(manifest.fixtureSha256)) return failed("INVALID_MANIFEST", { manifestPath });

  const fixturePath = resolve(root, manifest.fixture);
  if (!existsSync(fixturePath)) return failed("MISSING_FIXTURE", { fixture: manifest.fixture });
  const fixtureBytes = readFileSync(fixturePath);
  const fixtureSha256 = sha256(fixtureBytes);
  if (fixtureSha256 !== manifest.fixtureSha256) return failed("FIXTURE_HASH_MISMATCH", { fixture: manifest.fixture, expected: manifest.fixtureSha256, actual: fixtureSha256 });
  let fixture;
  try { fixture = JSON.parse(fixtureBytes.toString("utf8")); } catch (error) { return failed("INVALID_FIXTURE", { fixture: manifest.fixture, message: messageFor(error) }); }
  if (fixture.format !== "makefigma-phase1-render-fixture-v1" || fixture.name !== manifest.fixtureName || !isViewport(fixture.viewport) || !Array.isArray(fixture.nodes) || !Array.isArray(fixture.assets) || fixture.assets.length !== 1) return failed("INVALID_FIXTURE", { fixture: manifest.fixture });
  if (JSON.stringify(fixture.nodes.map((node) => [node?.name, node?.kind])) !== JSON.stringify(expectedNodes)) return failed("INVALID_NODE_COMPOSITION", { fixture: manifest.fixture });

  const [asset] = fixture.assets;
  if (!asset || typeof asset.assetId !== "string" || asset.mediaType !== "image/png" || !Number.isSafeInteger(asset.byteLength) || asset.byteLength <= 0 || !isSha256(asset.contentHash) || !Number.isSafeInteger(asset.pixelWidth) || !Number.isSafeInteger(asset.pixelHeight) || asset.pixelWidth <= 0 || asset.pixelHeight <= 0 || typeof asset.bytesBase64 !== "string") return failed("INVALID_ASSET_RECORD", { fixture: manifest.fixture });
  const imageNode = fixture.nodes[1];
  if (imageNode.assetId !== asset.assetId) return failed("IMAGE_ASSET_REFERENCE_MISMATCH", { fixture: manifest.fixture });
  let png;
  try { png = Buffer.from(asset.bytesBase64, "base64"); } catch { return failed("INVALID_ASSET_ENCODING", { fixture: manifest.fixture }); }
  if (png.byteLength !== asset.byteLength || sha256(png) !== asset.contentHash) return failed("ASSET_HASH_MISMATCH", { fixture: manifest.fixture });
  const dimensions = validPngDimensions(png);
  if (!dimensions) return failed("INVALID_PNG", { fixture: manifest.fixture });
  if (dimensions.width !== asset.pixelWidth || dimensions.height !== asset.pixelHeight) return failed("PNG_DIMENSION_MISMATCH", { fixture: manifest.fixture, expected: { width: asset.pixelWidth, height: asset.pixelHeight }, actual: dimensions });

  return { status: "pass", fixture: manifest.fixture, fixtureSha256, assetSha256: asset.contentHash, imageDimensions: dimensions, nodeCount: fixture.nodes.length };
}

function validPngDimensions(bytes) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (bytes.byteLength < 33 || !bytes.subarray(0, 8).equals(signature)) return undefined;
  const chunkLength = bytes.readUInt32BE(8);
  if (chunkLength !== 13 || bytes.subarray(12, 16).toString("ascii") !== "IHDR") return undefined;
  const expectedCrc = bytes.readUInt32BE(29);
  if (crc32(bytes.subarray(12, 29)) !== expectedCrc) return undefined;
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  return width > 0 && height > 0 ? { width, height } : undefined;
}

function crc32(bytes) {
  let value = -1;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  }
  return (value ^ -1) >>> 0;
}

function isViewport(value) { return value && [value.x, value.y, value.zoom].every(Number.isFinite) && value.zoom > 0; }
function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function isSha256(value) { return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value); }
function messageFor(error) { return error instanceof Error ? error.message : "unreadable"; }
function failed(reason, details) { return { status: "fail", reason, ...details }; }

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = verifyPhase1RenderCompositeFixture();
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.status === "pass" ? 0 : 1;
}
