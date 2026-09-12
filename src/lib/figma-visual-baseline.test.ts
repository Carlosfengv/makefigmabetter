import { describe, expect, it } from "vitest";
import { compareRgbaVisuals, createFigmaMcpVisualBaseline, createFigmaVisualBaseline, validateFigmaVisualBaseline } from "./figma-visual-baseline";

const oracle = {
  request: { fileKey: "abc123", nodeIds: ["1:2"], format: "png" as const, scale: 2, endpoint: "https://api.figma.com/v1/images/abc123?ids=1%3A2&format=png&scale=2" },
  images: { "1:2": "https://images.figma.example/reference.png" },
};
const input = {
  fixtureId: "F-P0-CARD",
  capturedAt: "2026-08-25T12:00:00.000Z",
  source: { figmaApiVersion: "v1", pluginTypingsVersion: "1.134.0" },
  environment: { browser: "Chromium 140", dpr: 2, colorProfile: "srgb" as const, normalization: ["decode-png", "premultiply-rgba"] },
  references: { "1:2": { path: "fixtures/golden-images/f-p0-card.png", sha256: "a".repeat(64) } },
  threshold: { maxChannelDelta: 3, maxMismatchedPixels: 1, maxMeanChannelDelta: .5 },
};

describe("Figma visual baseline", () => {
  it("records Oracle provenance without retaining its image URL or a credential", () => {
    const baseline = createFigmaVisualBaseline(oracle, input);
    expect(baseline.source).toMatchObject({ provider: "figma-images-rest", fileKey: "abc123", nodeIds: ["1:2"], pluginTypingsVersion: "1.134.0" });
    expect(JSON.stringify(baseline)).not.toContain("images.figma.example");
    expect(Object.isFrozen(baseline)).toBe(true);
  });

  it("records a stable Figma MCP design link without retaining its temporary export URL", () => {
    const baseline = createFigmaMcpVisualBaseline({
      ...input,
      source: {
        fileKey: "sOpexHz9cP8FTWJ8BvqBY2",
        nodeIds: ["1:90"],
        designUrl: "https://www.figma.com/design/sOpexHz9cP8FTWJ8BvqBY2/Untitled?node-id=1-90",
        format: "png",
        scale: 1,
        figmaApiVersion: "not-disclosed-by-mcp",
        pluginTypingsVersion: "1.134.0",
      },
      references: { "1:90": { path: "fixtures/golden-images/figma-mcp-reference.png", sha256: "b".repeat(64) } },
    });
    expect(baseline.source).toMatchObject({ provider: "figma-mcp", nodeIds: ["1:90"] });
    expect(JSON.stringify(baseline)).not.toContain("/api/mcp/asset/");
  });

  it("rejects a malformed checked-in sidecar", () => {
    expect(() => validateFigmaVisualBaseline({ ...createFigmaVisualBaseline(oracle, input), references: { "1:2": { path: "../secret.png", sha256: "bad" } } })).toThrow("Invalid Figma visual baseline");
  });

  it("reports a deterministic pixel gate from pre-normalized RGBA", () => {
    const reference = new Uint8Array([10, 20, 30, 255, 0, 0, 0, 255]);
    const accepted = compareRgbaVisuals(new Uint8Array([12, 20, 30, 255, 1, 0, 0, 255]), reference, 2, 1, input.threshold);
    expect(accepted).toMatchObject({ mismatchedPixels: 0, maxChannelDelta: 2, meanChannelDelta: .375, passed: true });
    const rejected = compareRgbaVisuals(new Uint8Array([16, 20, 30, 255, 10, 0, 0, 255]), reference, 2, 1, input.threshold);
    expect(rejected).toMatchObject({ mismatchedPixels: 2, maxChannelDelta: 10, passed: false });
  });
});
