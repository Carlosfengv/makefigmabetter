import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { createBaseline } from "./create-figma-visual-baseline.mjs";

test("creates a token-free baseline whose local artifact is hashed", async () => {
  const root = await mkdtemp(join(tmpdir(), "makefigma-baseline-"));
  const golden = join(root, "fixtures/golden-images");
  await writeFile(join(root, "oracle.json"), JSON.stringify({ request: { fileKey: "file", nodeIds: ["1:2"], endpoint: "https://api.figma.com/v1/images/file", format: "png", scale: 1 }, images: { "1:2": "https://temporary.figma.example/image" } }));
  await mkdir(golden, { recursive: true });
  await writeFile(join(golden, "card.png"), "pixels");
  await writeFile(join(root, "references.json"), JSON.stringify({ "1:2": "fixtures/golden-images/card.png" }));
  const baseline = await createBaseline({ oracle: "oracle.json", references: "references.json", out: "verification/baseline.json", fixture: "F-CARD", browser: "Chromium", dpr: "2", capturedAt: "2026-08-25T12:00:00.000Z" }, root);
  assert.equal(baseline.references["1:2"].sha256, createHash("sha256").update("pixels").digest("hex"));
  assert.equal(JSON.stringify(baseline).includes("temporary.figma.example"), false);
  assert.deepEqual(JSON.parse(await readFile(join(root, "verification/baseline.json"), "utf8")).source.nodeIds, ["1:2"]);
});

test("creates an MCP baseline without serializing its temporary asset URL", async () => {
  const root = await mkdtemp(join(tmpdir(), "makefigma-mcp-baseline-"));
  const golden = join(root, "fixtures/golden-images");
  await mkdir(golden, { recursive: true });
  await writeFile(join(golden, "frame.png"), "figma-mcp-pixels");
  await writeFile(join(root, "references.json"), JSON.stringify({ "1:90": "fixtures/golden-images/frame.png" }));
  const baseline = await createBaseline({ mcpUrl: "https://www.figma.com/design/sOpexHz9cP8FTWJ8BvqBY2/Untitled?node-id=1-90&t=volatile", references: "references.json", out: "verification/mcp-baseline.json", fixture: "F-MCP-REFERENCE", browser: "Chromium", dpr: "1", capturedAt: "2026-09-12T12:00:00.000Z" }, root);
  assert.deepEqual(baseline.source, {
    provider: "figma-mcp",
    fileKey: "sOpexHz9cP8FTWJ8BvqBY2",
    nodeIds: ["1:90"],
    designUrl: "https://www.figma.com/design/sOpexHz9cP8FTWJ8BvqBY2/Untitled?node-id=1-90",
    format: "png",
    scale: 1,
    figmaApiVersion: "not-disclosed-by-mcp",
    pluginTypingsVersion: "1.134.0",
  });
  assert.equal(JSON.stringify(baseline).includes("/api/mcp/asset/"), false);
});
