import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import fixture from "../../fixtures/documents/remediation-image-filters.fixture.json";

describe("W12-P image filters fixture", () => {
  it("contains a verified raster, an unfiltered control, and all seven adjustments", () => {
    const [asset] = fixture.assets;
    const bytes = Buffer.from(asset.bytesBase64, "base64");
    expect(bytes.byteLength).toBe(asset.byteLength);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(asset.contentHash);
    const filtered = fixture.nodes[2];
    expect("fillStack" in filtered && filtered.fillStack.layers[0].image.filters).toEqual({
      exposure: .25,
      contrast: -.2,
      saturation: .4,
      temperature: .3,
      tint: -.15,
      highlights: .5,
      shadows: -.35,
    });
    expect(new Set(fixture.nodes.map((node) => node.id)).size).toBe(fixture.nodes.length);
  });
});
