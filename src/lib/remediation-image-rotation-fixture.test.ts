import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import fixture from "../../fixtures/documents/remediation-image-rotation.fixture.json";

describe("W12-P image rotation fixture", () => {
  it("contains one asymmetric asset and every canonical quarter-turn", () => {
    const [asset] = fixture.assets;
    const bytes = Buffer.from(asset.bytesBase64, "base64");
    expect(bytes.byteLength).toBe(asset.byteLength);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(
      asset.contentHash,
    );
    expect([asset.pixelWidth, asset.pixelHeight]).toEqual([4, 2]);
    expect(
      fixture.nodes.slice(1).map((node) =>
        "fillStack" in node
          ? node.fillStack.layers[0].image.rotationDegrees ?? 0
          : undefined,
      ),
    ).toEqual([0, 90, 180, 270]);
    expect(new Set(fixture.nodes.map((node) => node.id)).size).toBe(
      fixture.nodes.length,
    );
  });
});
