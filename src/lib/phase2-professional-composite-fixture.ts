import { createNode, type CanvasNode, type DocumentAsset, type DocumentColor, type Viewport } from "./editor-protocol";

export const PHASE2_PROFESSIONAL_COMPOSITE_FIXTURE_NAME = "F-PHASE2-PROFESSIONAL-COMPOSITE";

export interface Phase2ProfessionalCompositeFixture {
  format: "makefigma-phase2-professional-composite-fixture-v1";
  name: typeof PHASE2_PROFESSIONAL_COMPOSITE_FIXTURE_NAME;
  viewport: Viewport;
  nodes: CanvasNode[];
  assets: Array<DocumentAsset & { bytesBase64?: string; preRegistered?: true }>;
}

const black25: DocumentColor = { space: "srgb", components: [0, 0, 0], alpha: .25 };
const white35: DocumentColor = { space: "srgb", components: [1, 1, 1], alpha: .35 };
const fixtureAssets: Phase2ProfessionalCompositeFixture["assets"] = [
  { assetId: "00000000-0000-4000-8000-0000000030a1", contentHash: "1111111111111111111111111111111111111111111111111111111111111111", mediaType: "image/png", byteLength: 172, pixelWidth: 24, pixelHeight: 16, preRegistered: true },
  { assetId: "00000000-0000-4000-8000-0000000030a2", contentHash: "fe947058e63cfba192ac429afbb098a1609eaf67842f60415fb000efe3a9385d", mediaType: "image/png", byteLength: 172, pixelWidth: 24, pixelHeight: 16, bytesBase64: "iVBORw0KGgoAAAANSUhEUgAAABgAAAAQCAYAAAAMJL+VAAAAc0lEQVR4nGMwzPz/H4Yrw2/CMTHibxv84Pj/9jg4RhZnINdwEJ+Q4SA+A7mGwyzAZzjYAnINB2FChqNYQE5cEDIcHAfkGg6zgFBEM5Br+GgqIttSdHGKUhEx4hSlImLEKUpFxIhTlIqIEacoFREjTvNUBABqqQXuv6sGOgAAAABJRU5ErkJggg==", preRegistered: true },
  // Inter Regular subset containing “Design”, embedded from the upstream OFL font so fixture loading exercises a real FontFace without a network request.
  { assetId: "00000000-0000-4000-8000-0000000030f1", contentHash: "57b89bf9d855ed8e60165d65ef0afce1793c374b7860dec00ef22d755169cfea", mediaType: "font/ttf", byteLength: 2896, bytesBase64: "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", preRegistered: true },
];

/** A small but intentionally dense Phase 2 scene. Its fixed IDs and source
 * order make it suitable for browser Golden, export and repeated-edit evidence
 * without pretending to be a production-design approval fixture. */
export function createPhase2ProfessionalCompositeFixture(): Phase2ProfessionalCompositeFixture {
  const root = fixtureNode("frame", "00000000-0000-4000-8000-000000003001", "Professional composite", -480, -340, {
    width: 960, height: 680, fill: "#101827", stroke: "#334155", strokeWidth: 2, cornerRadii: [28, 28, 28, 28], clipsContent: true,
  });
  const layoutOne = fixtureNode("frame", "00000000-0000-4000-8000-000000003002", "Auto layout level 1", 36, 36, {
    parentId: root.id, width: 400, height: 430, fill: "#e2e8f0", stroke: "#94a3b8", strokeWidth: 1, radius: 20,
    autoLayout: layout("vertical", [20, 20, 20, 20], 16),
  });
  const layoutTwo = fixtureNode("frame", "00000000-0000-4000-8000-000000003003", "Auto layout level 2", 20, 20, {
    parentId: layoutOne.id, width: 360, height: 150, fill: "#ffffff", stroke: "#cbd5e1", strokeWidth: 1, radius: 16,
    autoLayout: layout("horizontal", [16, 16, 16, 16], 12),
  });
  const layoutThree = fixtureNode("frame", "00000000-0000-4000-8000-000000003004", "Auto layout level 3", 16, 16, {
    parentId: layoutTwo.id, width: 210, height: 118, fill: "#f8fafc", stroke: "transparent", strokeWidth: 0, radius: 12,
    autoLayout: layout("vertical", [8, 8, 8, 8], 6),
  });
  const title = fixtureNode("text", "00000000-0000-4000-8000-000000003005", "Mixed-language title", 8, 8, {
    parentId: layoutThree.id, width: 190, height: 34, fill: "#0f172a", text: "Design · 中文 · مرحبا · 👋",
    textProperties: { runs: [{ start: 0, end: 38, fontSize: 18, fontWeight: 700, italic: false, letterSpacing: .1 }], paragraph: { alignment: "left", lineHeight: 26, paragraphSpacing: 0 }, autoSize: "height", fallbackFonts: [{ assetId: "00000000-0000-4000-8000-0000000030f1", faceIndex: 0 }] },
  });
  const paragraph = fixtureNode("text", "00000000-0000-4000-8000-000000003006", "Multilingual paragraphs", 8, 44, {
    parentId: layoutThree.id, width: 190, height: 64, fill: "#334155", text: "RTL: مرحبا بالعالم\nEmoji: 👩‍💻 é",
    textProperties: { runs: [], paragraph: { alignment: "left", lineHeight: 22, paragraphSpacing: 6 }, autoSize: "height", fallbackFonts: [] },
  });
  const avatar = fixtureNode("ellipse", "00000000-0000-4000-8000-000000003007", "Gradient avatar", 250, 16, {
    parentId: layoutTwo.id, width: 94, height: 94, fill: "#38bdf8", stroke: "#0c4a6e", strokeWidth: 3,
  });
  const effectCard = fixtureNode("rectangle", "00000000-0000-4000-8000-000000003008", "Blur and blend card", 492, 60, {
    parentId: root.id, width: 300, height: 192, fill: "#6366f1", stroke: "#a5b4fc", strokeWidth: 2, radius: 24, blendMode: "overlay",
    effectStack: [
      { dropShadow: { offsetX: 10, offsetY: 14, blurRadius: 18, spread: 0, color: black25, visible: true } },
      { layerBlur: { radius: 3, visible: true } },
      { innerShadow: { offsetX: -3, offsetY: -4, blurRadius: 8, spread: 0, color: white35, visible: true } },
      { backgroundBlur: { radius: 12, visible: true } },
    ],
  });
  const mask = fixtureNode("ellipse", "00000000-0000-4000-8000-000000003009", "Alpha mask", 500, 300, {
    parentId: root.id, width: 160, height: 150, fill: "#ffffff", stroke: "transparent", strokeWidth: 0, isMask: true,
  });
  const maskedTarget = fixtureNode("rectangle", "00000000-0000-4000-8000-000000003010", "Masked texture target", 480, 282, {
    parentId: root.id, width: 320, height: 190, fill: "#ec4899", stroke: "#831843", strokeWidth: 3, radius: 28,
  });
  const image = fixtureNode("image", "00000000-0000-4000-8000-000000003011", "Seeded image asset", 36, 500, {
    parentId: root.id, width: 180, height: 112, assetId: "00000000-0000-4000-8000-0000000030a2", fill: "#dbeafe", stroke: "#60a5fa", strokeWidth: 2,
  });
  const missingImage = fixtureNode("image", "00000000-0000-4000-8000-000000003019", "Missing image fallback", 240, 610, {
    parentId: root.id, width: 180, height: 60, assetId: "00000000-0000-4000-8000-0000000030a1", fill: "#dbeafe", stroke: "#60a5fa", strokeWidth: 2,
  });
  const polygon = fixtureNode("polygon", "00000000-0000-4000-8000-000000003012", "Polygon", 250, 500, { parentId: root.id, width: 94, height: 94, fill: "#bef264", stroke: "#3f6212", strokeWidth: 3 });
  const star = fixtureNode("star", "00000000-0000-4000-8000-000000003013", "Star", 365, 494, { parentId: root.id, width: 106, height: 106, fill: "#fbbf24", stroke: "#92400e", strokeWidth: 3 });
  const boolean = fixtureNode("booleanOperation", "00000000-0000-4000-8000-000000003014", "Boolean union", 492, 500, { parentId: root.id, width: 130, height: 90, booleanOperation: "union" });
  const booleanLeft = vectorNode("00000000-0000-4000-8000-000000003015", "Boolean operand A", 0, 0, boolean.id, "#22c55e");
  const booleanRight = vectorNode("00000000-0000-4000-8000-000000003016", "Boolean operand B", 42, 18, boolean.id, "#16a34a");
  const outline = vectorNode("00000000-0000-4000-8000-000000003017", "Outline stroke result", 620, 514, root.id, "#c4b5fd");
  // Keep this second sibling run after all ordinary content so it exercises
  // two independent alpha masks without changing the first mask's targets.
  const independentMask = fixtureNode("ellipse", "00000000-0000-4000-8000-000000003020", "Independent alpha mask", 748, 530, {
    parentId: root.id, width: 132, height: 112, fill: "#ffffff", stroke: "transparent", strokeWidth: 0, isMask: true,
  });
  const independentlyMaskedBadge = fixtureNode("rectangle", "00000000-0000-4000-8000-000000003021", "Independently masked badge", 718, 512, {
    parentId: root.id, width: 190, height: 146, fill: "#14b8a6", stroke: "#115e59", strokeWidth: 3, radius: 22,
  });
  const slice = fixtureNode("slice", "00000000-0000-4000-8000-000000003018", "Professional export Slice", 452, 28, { parentId: root.id, width: 370, height: 470, rotation: -4, fill: "transparent", stroke: "transparent", strokeWidth: 0 });

  return { format: "makefigma-phase2-professional-composite-fixture-v1", name: PHASE2_PROFESSIONAL_COMPOSITE_FIXTURE_NAME, viewport: { x: 0, y: 0, zoom: 1 }, assets: fixtureAssets.map((asset) => ({ ...asset })), nodes: [root, layoutOne, layoutTwo, layoutThree, title, paragraph, avatar, effectCard, mask, maskedTarget, image, missingImage, polygon, star, boolean, booleanLeft, booleanRight, outline, independentMask, independentlyMaskedBadge, slice] };
}

function fixtureNode(kind: CanvasNode["kind"], id: string, name: string, x: number, y: number, patch: Partial<CanvasNode>): CanvasNode {
  // Fixture hierarchy intentionally uses Relative-v1 instead of legacy world
  // coordinates. Otherwise a nested Auto Layout child at (0, 0) is painted at
  // the Page origin while its frame clip is in parent space, making a valid
  // export look blank. Keep x/y as the human-readable local fallback and make
  // the shared Canvas/SVG world-matrix resolver the actual source of position.
  const relativeTransform = patch.parentId ? { a: 1, b: 0, c: 0, d: 1, e: x, f: y } : undefined;
  return { ...createNode(kind, x, y), id, name, ...patch, relativeTransform };
}

function vectorNode(id: string, name: string, x: number, y: number, parentId: string, fill: string): CanvasNode {
  return fixtureNode("vector", id, name, x, y, {
    parentId, width: 96, height: 76, fill, stroke: "#14532d", strokeWidth: 2,
    vectorPath: { fillRule: "nonZero", subpaths: [{ closed: true, points: [
      { id: `${id.slice(0, -1)}1`, x: 4, y: 4, pointType: "corner" },
      { id: `${id.slice(0, -1)}2`, x: 92, y: 12, pointType: "corner" },
      { id: `${id.slice(0, -1)}3`, x: 58, y: 72, pointType: "corner" },
      { id: `${id.slice(0, -1)}4`, x: 8, y: 58, pointType: "corner" },
    ] }] },
  });
}

function layout(mode: "horizontal" | "vertical", padding: [number, number, number, number], itemSpacing: number) {
  return { mode, padding, itemSpacing, wrap: false, primaryAlignment: "start" as const, counterAlignment: "start" as const, primarySizing: "fixed" as const, counterSizing: "fixed" as const, absolute: false };
}
