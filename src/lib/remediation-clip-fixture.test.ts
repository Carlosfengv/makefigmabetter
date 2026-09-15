import { describe, expect, it } from "vitest";
import { clipStateContainsPoint, compileScene } from "../runtime/scene-compiler";
import { exportPageToSvg } from "./svg-export";
import { createRemediationClipFixture, REMEDIATION_CLIP_FIXTURE_IDS } from "./remediation-clip-fixture";

const pageId = "00000000-0000-0000-0000-000000000001";

describe("RF-03/RF-04 container clip fixture", () => {
  it("gives every supported Figma-style container child a bounded exact clip", () => {
    const fixture = createRemediationClipFixture();
    const compiled = compileScene({ revision: 1, pageId, nodes: fixture.nodes });

    for (const id of [
      REMEDIATION_CLIP_FIXTURE_IDS.frameChild,
      REMEDIATION_CLIP_FIXTURE_IDS.componentChild,
      REMEDIATION_CLIP_FIXTURE_IDS.instanceChild,
      REMEDIATION_CLIP_FIXTURE_IDS.slotChild,
      REMEDIATION_CLIP_FIXTURE_IDS.componentSetChild,
    ]) {
      expect(compiled.scene.semanticNodes.find((node) => node.nodeId === id)?.clipState).toMatchObject({
        kind: "bounded",
        chain: [expect.objectContaining({ geometry: "rounded-rect" })],
      });
    }
  });

  it("propagates a disjoint nested clip as empty and retains exact affine geometry", () => {
    const fixture = createRemediationClipFixture();
    const compiled = compileScene({ revision: 2, pageId, nodes: fixture.nodes });
    const disjoint = compiled.scene.semanticNodes.find((node) => node.nodeId === REMEDIATION_CLIP_FIXTURE_IDS.disjointTarget);
    const affine = compiled.scene.semanticNodes.find((node) => node.nodeId === REMEDIATION_CLIP_FIXTURE_IDS.affineChild);
    const reflectedSkew = compiled.scene.semanticNodes.find((node) => node.nodeId === REMEDIATION_CLIP_FIXTURE_IDS.reflectedSkewChild);

    expect(disjoint).toMatchObject({ visible: false, paintable: false, clipState: { kind: "empty" } });
    expect(affine?.clipState).toMatchObject({
      kind: "bounded",
      chain: [expect.objectContaining({ nodeId: REMEDIATION_CLIP_FIXTURE_IDS.affineFrame, geometry: "rounded-rect", cornerSmoothing: 0.35 })],
    });
    expect(clipStateContainsPoint(affine!.clipState, { x: 100, y: 98 })).toBe(true);
    expect(clipStateContainsPoint(affine!.clipState, { x: 30, y: 25 })).toBe(false);
    expect(reflectedSkew?.clipState).toMatchObject({
      kind: "bounded",
      chain: [expect.objectContaining({
        nodeId: REMEDIATION_CLIP_FIXTURE_IDS.reflectedSkewFrame,
        worldTransform: { a: -1, b: .2, c: .35, d: 1, e: 330, f: 70 },
      })],
    });
    expect(clipStateContainsPoint(reflectedSkew!.clipState, { x: 302.5, y: 129 })).toBe(true);
    expect(clipStateContainsPoint(reflectedSkew!.clipState, { x: 360, y: 75 })).toBe(false);
  });

  it("exports each supported container clip and preserves nested SVG clip scope", () => {
    const fixture = createRemediationClipFixture();
    const result = exportPageToSvg(fixture.nodes, { pageId, defaultPageId: pageId, padding: 0 });

    expect(result.svg.match(/<clipPath id="makefigma-clip-/g)?.length).toBeGreaterThanOrEqual(8);
    // SVG keeps the source element under two nested clip wrappers. The empty
    // intersection is resolved by the SVG rasterizer rather than by deleting
    // Canonical content from the portable output.
    expect(result.svg).toContain("#7c3aed");
    expect(result.svg.match(/<g clip-path="url\(#makefigma-clip-/g)?.length).toBeGreaterThanOrEqual(8);
    expect(result.svg).toContain("#06b6d4");
    const firstChild = result.svg.indexOf("#ef4444");
    const firstOwnerStroke = result.svg.indexOf("#111827");
    expect(firstChild).toBeGreaterThan(-1);
    expect(firstOwnerStroke).toBeGreaterThan(firstChild);
  });
});
