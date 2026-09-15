import { describe, expect, it } from "vitest";
import { createPhase2ProfessionalCompositeFixture, PHASE2_PROFESSIONAL_COMPOSITE_FIXTURE_NAME } from "./phase2-professional-composite-fixture";
import { normalizeAutoLayoutProjection, resolveCoreBatch } from "./transaction-batch";
import { exportPageToSvg } from "./svg-export";
import { withPdfRasterizationFallback } from "./export-compatibility";
import { worldTransformForNode } from "./scene-transform";
import { textFrozenLayoutFace } from "./text-svg-layout-input";

describe("F-PHASE2-PROFESSIONAL-COMPOSITE fixture", () => {
  it("freezes the complex Phase 2 evidence surface and its structural coverage", () => {
    const fixture = createPhase2ProfessionalCompositeFixture();
    const names = fixture.nodes.map((node) => node.name);
    const byName = (name: string) => fixture.nodes.find((node) => node.name === name);
    const root = byName("Professional composite");
    const layoutOne = byName("Auto layout level 1");
    const layoutTwo = byName("Auto layout level 2");
    const layoutThree = byName("Auto layout level 3");
    const title = byName("Mixed-language title");
    const paragraph = byName("Multilingual paragraphs");
    const composedEffectBar = byName("Composed layer blur and shadow");
    const mask = byName("Alpha mask");
    const maskedTarget = byName("Masked texture target");
    const maskedRun = byName("Masked texture run");
    const independentMask = byName("Independent alpha mask");
    const independentlyMaskedBadge = byName("Independently masked badge");
    const independentlyMaskedRun = byName("Independently masked badge run");
    const seededImage = byName("Seeded image asset");
    const missingImage = byName("Missing image fallback");
    const boolean = byName("Boolean union");
    const slice = byName("Professional export Slice");
    const embeddedFont = fixture.assets.find((asset) => asset.mediaType === "font/ttf");

    expect(fixture).toMatchObject({ format: "makefigma-phase2-professional-composite-fixture-v1", name: PHASE2_PROFESSIONAL_COMPOSITE_FIXTURE_NAME, viewport: { x: 0, y: 0, zoom: 1 } });
    expect(names).toEqual(expect.arrayContaining(["Auto layout level 1", "Auto layout level 2", "Auto layout level 3", "Mixed-language title", "Masked texture run", "Alpha mask", "Masked texture target", "Independently masked badge run", "Independent alpha mask", "Independently masked badge", "Blur and blend card", "Composed layer blur and shadow", "Boolean union", "Outline stroke result", "Professional export Slice"]));
    expect(fixture.nodes.filter((node) => node.autoLayout).map((node) => node.name)).toEqual(["Auto layout level 1", "Auto layout level 2", "Auto layout level 3"]);
    expect(root).toMatchObject({ clipsContent: true });
    expect(layoutOne).toMatchObject({ parentId: root?.id, autoLayout: { mode: "vertical" } });
    expect(layoutTwo).toMatchObject({ parentId: layoutOne?.id, autoLayout: { mode: "horizontal" } });
    expect(layoutThree).toMatchObject({ parentId: layoutTwo?.id, autoLayout: { mode: "vertical" } });
    expect(title).toMatchObject({ parentId: layoutThree?.id, text: expect.stringContaining("中文"), textProperties: { runs: expect.arrayContaining([expect.objectContaining({ start: 0, end: expect.any(Number) })]), fallbackFonts: [expect.objectContaining({ assetId: embeddedFont?.assetId })] } });
    expect(title?.textProperties?.runs.map(({ start, end }) => ({ start, end }))).toEqual([
      { start: 0, end: 10 }, { start: 10, end: 20 }, { start: 20, end: 34 }, { start: 34, end: 38 },
    ]);
    expect(new TextEncoder().encode(title?.text).byteLength).toBe(38);
    expect(title?.textProperties?.runs.map((run) => run.color?.components)).toEqual([
      [.059, .09, .165], [.109, .24, .59], [.49, .08, .2], [.78, .35, .05],
    ]);
    expect(textFrozenLayoutFace(title!)).toMatchObject({ font: { assetId: embeddedFont?.assetId, faceIndex: 0 }, fontSize: 18 });
    expect(paragraph).toMatchObject({ parentId: layoutThree?.id, text: expect.stringContaining("مرحبا") });
    expect(paragraph?.text).toContain("👩‍💻");
    expect(maskedRun).toMatchObject({ parentId: root?.id, kind: "group" });
    expect(mask).toMatchObject({ parentId: maskedRun?.id, isMask: true });
    expect(maskedTarget).toMatchObject({ parentId: maskedRun?.id });
    expect(independentlyMaskedRun).toMatchObject({ parentId: root?.id, kind: "group" });
    expect(independentMask).toMatchObject({ parentId: independentlyMaskedRun?.id, isMask: true });
    expect(independentlyMaskedBadge).toMatchObject({ parentId: independentlyMaskedRun?.id });
    expect(fixture.nodes.filter((node) => node.isMask)).toEqual([mask, independentMask]);
    expect(fixture.nodes.indexOf(independentMask!)).toBe(fixture.nodes.indexOf(independentlyMaskedBadge!) - 1);
    expect(fixture.assets).toEqual(expect.arrayContaining([expect.objectContaining({ assetId: seededImage?.assetId, mediaType: "image/png", bytesBase64: expect.any(String) }), expect.objectContaining({ assetId: missingImage?.assetId, mediaType: "image/png" }), expect.objectContaining({ mediaType: "font/ttf", bytesBase64: expect.any(String), preRegistered: true })]));
    const fontBytes = Uint8Array.from(atob(embeddedFont!.bytesBase64!), (byte) => byte.charCodeAt(0));
    expect(fontBytes.byteLength).toBe(embeddedFont?.byteLength);
    expect([...fontBytes.slice(0, 4)]).toEqual([0, 1, 0, 0]);
    expect(embeddedFont?.contentHash).toBe("57b89bf9d855ed8e60165d65ef0afce1793c374b7860dec00ef22d755169cfea");
    expect(seededImage).toMatchObject({ parentId: root?.id, kind: "image", assetId: expect.any(String) });
    expect(missingImage).toMatchObject({ parentId: root?.id, kind: "image", assetId: expect.any(String) });
    expect(fixture.nodes.find((node) => node.name === "Blur and blend card")).toMatchObject({
      blendMode: "overlay",
      effectStack: expect.arrayContaining([
        expect.objectContaining({ layerBlur: expect.any(Object) }),
        expect.objectContaining({ backgroundBlur: expect.any(Object) }),
      ]),
    });
    expect(fixture.nodes.filter((node) => node.name.startsWith("Blend ")).map((node) => node.blendMode)).toEqual([
      "normal", "multiply", "screen", "overlay", "darken", "lighten",
    ]);
    expect(composedEffectBar).toMatchObject({
      parentId: root?.id,
      effectStack: [
        { layerBlur: { radius: 2, visible: true } },
        { dropShadow: { offsetX: 0, offsetY: 3, blurRadius: 6, spread: 0, color: { space: "srgb", components: [0, 0, 0], alpha: .25 }, visible: true } },
        { innerShadow: { offsetX: -2, offsetY: 1, blurRadius: 4, spread: 1, color: { space: "srgb", components: [1, 1, 1], alpha: .35 }, visible: true } },
      ],
    });
    expect(boolean).toMatchObject({ parentId: root?.id, kind: "booleanOperation", booleanOperation: "union" });
    expect(fixture.nodes.filter((node) => node.parentId === boolean?.id && node.kind === "vector")).toHaveLength(2);
    expect(byName("Outline stroke result")).toMatchObject({ parentId: root?.id, kind: "vector", vectorPath: expect.any(Object) });
    expect(slice).toMatchObject({ parentId: root?.id, kind: "slice", rotation: expect.any(Number) });
    expect(worldTransformForNode(fixture.nodes, layoutOne!.id)).toMatchObject({ e: -444, f: -304 });
    expect(worldTransformForNode(fixture.nodes, layoutTwo!.id)).toMatchObject({ e: -424, f: -284 });
    expect(worldTransformForNode(fixture.nodes, layoutThree!.id)).toMatchObject({ e: -408, f: -268 });
    expect(worldTransformForNode(fixture.nodes, title!.id)).toMatchObject({ e: -400, f: -260 });

    const normalized = normalizeAutoLayoutProjection(fixture.nodes);
    for (const node of [layoutOne, layoutTwo, layoutThree, title, paragraph]) {
      const before = worldTransformForNode(fixture.nodes, node!.id);
      const after = worldTransformForNode(normalized, node!.id);
      expect(normalized.find((candidate) => candidate.id === node!.id)?.relativeTransform).toBeUndefined();
      expect(after).toMatchObject({ e: before?.e, f: before?.f });
    }
  });

  it("is accepted by the same atomic Canonical create path as editor documents", () => {
    const fixture = createPhase2ProfessionalCompositeFixture();
    const resolved = resolveCoreBatch([], fixture.nodes.map((node) => ({ type: "create" as const, node })));

    expect(resolved?.nextNodes).toHaveLength(fixture.nodes.length);
    expect(resolved?.nextNodes.find((node) => node.name === "Boolean union")?.kind).toBe("booleanOperation");
  });

  it("keeps SVG delivery explicit about every professional-fixture fallback", () => {
    const fixture = createPhase2ProfessionalCompositeFixture();
    const root = fixture.nodes.find((node) => node.name === "Professional composite");
    const composedEffectBar = fixture.nodes.find((node) => node.name === "Composed layer blur and shadow");
    const svg = exportPageToSvg(fixture.nodes, { pageId: root?.pageId, defaultPageId: root?.pageId, padding: 0 });
    const pdf = withPdfRasterizationFallback(svg, root?.id ?? "professional-page");

    expect(svg.svg).toContain("<svg");
    expect(svg.svg).toContain("mix-blend-mode:overlay");
    for (const mode of ["multiply", "screen", "overlay", "darken", "lighten"])
      expect(svg.svg).toContain(`mix-blend-mode:${mode}`);
    expect(svg.svg).toContain("makefigma-composed-effect-");
    expect(svg.svg).toContain('result="innerMask-2"');
    expect(svg.compatibilityFallbacks).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ nodeId: composedEffectBar?.id, capability: "layer-blur" }),
      expect.objectContaining({ nodeId: composedEffectBar?.id, capability: "inner-shadow" }),
      expect.objectContaining({ nodeId: composedEffectBar?.id, capability: "shadow-spread" }),
    ]));
    expect(svg.svg).toContain("mask-type=\"alpha\"");
    expect(svg.svg.match(/<mask\b/g)).toHaveLength(2);
    expect(svg.svg).toContain("clipPathUnits=\"userSpaceOnUse\"");
    expect(svg.svg).not.toMatch(/<clipPath[^>]*><g transform=/);
    expect(svg.compatibilityFallbacks.map((fallback) => fallback.capability)).toEqual(expect.arrayContaining([
      "layer-blur", "inner-shadow", "background-blur", "image-asset", "font-asset", "text-layout", "live-boolean",
    ]));
    expect(pdf.compatibilityFallbacks.map((fallback) => fallback.capability)).toEqual(expect.arrayContaining(["pdf-rasterization"]));
  });

  it("keeps the fixture's alpha mask when its masked target is exported alone", () => {
    const fixture = createPhase2ProfessionalCompositeFixture();
    const root = fixture.nodes.find((node) => node.name === "Professional composite");
    const target = fixture.nodes.find((node) => node.name === "Masked texture target");
    if (!root || !target) throw new Error("Professional fixture is incomplete");

    const svg = exportPageToSvg(fixture.nodes, { pageId: root.pageId!, defaultPageId: root.pageId!, padding: 0, nodeIds: [target.id] });

    expect(svg.svg).toContain('mask-type="alpha"');
    expect(svg.svg).toContain('mask="url(#makefigma-alpha-mask-');
  });
});
