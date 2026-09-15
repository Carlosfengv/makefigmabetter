import { createNode, documentColorFromCssHex, type CanvasNode, type DocumentAsset, type NodeKind, type Viewport } from "./editor-protocol";
import { createPhase2ProfessionalCompositeFixture } from "./phase2-professional-composite-fixture";

export type RemediationTextPathGpuFixture = {
  format: "makefigma-remediation-text-path-gpu-fixture-v1";
  viewport: Viewport;
  assets: Array<DocumentAsset & { bytesBase64?: string; preRegistered?: true }>;
  nodes: CanvasNode[];
};

export type RemediationTextPathStructuredFixture = Omit<
  RemediationTextPathGpuFixture,
  "format"
> & {
  format: "makefigma-remediation-text-path-structured-fixture-v1";
};

/** Browser gate for rich-run Rust glyphs projected onto an authored cubic. */
export function createRemediationTextPathGpuFixture(): RemediationTextPathGpuFixture {
  const font = createPhase2ProfessionalCompositeFixture().assets.find(
    (asset) => asset.mediaType === "font/ttf" && asset.bytesBase64,
  );
  if (!font?.bytesBase64) throw new Error("Embedded TextPath fixture font is unavailable");
  const textPath: CanvasNode = {
    ...createNode("textPath", -220, -90),
    id: "00000000-0000-4000-8000-0000000038c2",
    name: "Shaped rich-run TextPath",
    width: 440,
    height: 180,
    fill: "#0f172a",
    text: "Design",
    vectorPath: {
      fillRule: "nonZero",
      subpaths: [{ closed: false, points: [
        { id: "00000000-0000-4000-8000-0000000038a1", x: 0, y: 105, handleOut: { x: 110, y: -100 }, pointType: "asymmetric" },
        { id: "00000000-0000-4000-8000-0000000038a2", x: 440, y: 105, handleIn: { x: -110, y: 100 }, pointType: "asymmetric" },
      ] }],
    },
    textPathMetadata: { startSegment: 0, startPosition: .08, autoRename: false, textAlignHorizontal: "CENTER", textAlignVertical: "CENTER" },
    textProperties: {
      runs: [
        { start: 0, end: 3, font: { assetId: font.assetId, faceIndex: 0 }, fontSize: 28, fontWeight: 400, italic: false, letterSpacing: 1, color: { space: "srgb", components: [.9, .1, .1], alpha: 1 } },
        { start: 3, end: 6, font: { assetId: font.assetId, faceIndex: 0 }, fontSize: 46, fontWeight: 700, italic: true, letterSpacing: -0.5, color: { space: "srgb", components: [.1, .25, .95], alpha: .9 } },
      ],
      paragraph: { alignment: "left", lineHeight: 56, paragraphSpacing: 0 },
      autoSize: "fixed",
      fallbackFonts: [],
    },
  };
  return {
    format: "makefigma-remediation-text-path-gpu-fixture-v1",
    viewport: { x: 0, y: 0, zoom: 1 },
    assets: [{ ...font }],
    nodes: [textPath],
  };
}

/** Browser gate for the two transform paths that cannot share projection space. */
export function createRemediationTextPathTransformFixture(): RemediationTextPathGpuFixture {
  const fixture = createRemediationTextPathGpuFixture();
  const source = fixture.nodes[0]!;
  const rotated: CanvasNode = {
    ...structuredClone(source),
    id: "00000000-0000-4000-8000-0000000038d1",
    name: "Rotated shaped TextPath",
    x: -430,
    y: -180,
    rotation: 28,
  };
  const affine: CanvasNode = {
    ...structuredClone(source),
    id: "00000000-0000-4000-8000-0000000038d2",
    name: "Affine shaped TextPath",
    x: 20,
    y: 80,
    rotation: 0,
    relativeTransform: { a: .94, b: .22, c: .28, d: .88, e: 20, f: 80 },
  };
  return { ...fixture, nodes: [rotated, affine] };
}

/** Browser gate for TextPath inside the three structural Canvas contracts that
 * must preserve the surrounding clip, mask and subtree effect as one root. */
export function createRemediationTextPathStructuredFixture(): RemediationTextPathStructuredFixture {
  const fixture = createRemediationTextPathGpuFixture();
  const source = fixture.nodes[0]!;
  const background = paintedNode(
    "rectangle",
    "00000000-0000-4000-8000-000000003901",
    "Structured TextPath backdrop",
    -600,
    -320,
    { width: 1200, height: 640, fill: "#e2e8f0", stroke: "transparent", strokeWidth: 0 },
  );

  const clipFrame = paintedNode(
    "frame",
    "00000000-0000-4000-8000-000000003910",
    "TextPath clipped frame",
    -540,
    -150,
    {
      width: 320,
      height: 240,
      fill: "#fff7ed",
      stroke: "#c2410c",
      strokeWidth: 4,
      radius: 28,
      clipsContent: true,
    },
  );
  const clippedTextPath = structuredTextPath(
    source,
    "00000000-0000-4000-8000-000000003911",
    "Clipped shaped TextPath",
    clipFrame.id,
    -60,
    30,
    ["00000000-0000-4000-8000-000000003912", "00000000-0000-4000-8000-000000003913"],
  );

  const maskGroup = paintedNode(
    "group",
    "00000000-0000-4000-8000-000000003920",
    "TextPath mask run",
    -160,
    -150,
    { width: 320, height: 240, fill: "transparent", stroke: "transparent", strokeWidth: 0 },
  );
  const maskPanel = paintedNode(
    "rectangle",
    "00000000-0000-4000-8000-000000003921",
    "Mask panel",
    0,
    0,
    {
      parentId: maskGroup.id,
      relativeTransform: translation(0, 0),
      width: 320,
      height: 240,
      fill: "#eff6ff",
      stroke: "#1d4ed8",
      strokeWidth: 4,
      radius: 28,
    },
  );
  const mask = paintedNode(
    "ellipse",
    "00000000-0000-4000-8000-000000003922",
    "TextPath ellipse mask",
    30,
    20,
    {
      parentId: maskGroup.id,
      relativeTransform: translation(30, 20),
      width: 260,
      height: 200,
      fill: "#ffffff",
      stroke: "transparent",
      strokeWidth: 0,
      opacity: .78,
      isMask: true,
    },
  );
  const maskedTextPath = structuredTextPath(
    source,
    "00000000-0000-4000-8000-000000003923",
    "Masked shaped TextPath",
    maskGroup.id,
    -60,
    30,
    ["00000000-0000-4000-8000-000000003924", "00000000-0000-4000-8000-000000003925"],
  );

  const effectGroup = paintedNode(
    "group",
    "00000000-0000-4000-8000-000000003930",
    "TextPath effect group",
    220,
    -150,
    {
      width: 320,
      height: 240,
      fill: "transparent",
      stroke: "transparent",
      strokeWidth: 0,
      opacity: .72,
      effectStack: [{
        dropShadow: {
          offsetX: 14,
          offsetY: 18,
          blurRadius: 18,
          spread: 0,
          color: { space: "srgb", components: [.04, .09, .2], alpha: .5 },
          visible: true,
        },
      }],
    },
  );
  const effectPanel = paintedNode(
    "rectangle",
    "00000000-0000-4000-8000-000000003931",
    "Effect panel",
    0,
    0,
    {
      parentId: effectGroup.id,
      relativeTransform: translation(0, 0),
      width: 320,
      height: 240,
      fill: "#f0fdf4",
      stroke: "#15803d",
      strokeWidth: 4,
      radius: 28,
    },
  );
  const effectedTextPath = structuredTextPath(
    source,
    "00000000-0000-4000-8000-000000003932",
    "Effected shaped TextPath",
    effectGroup.id,
    -60,
    30,
    ["00000000-0000-4000-8000-000000003933", "00000000-0000-4000-8000-000000003934"],
  );
  const finalMarker = paintedNode(
    "rectangle",
    "00000000-0000-4000-8000-000000003940",
    "GPU resume marker",
    500,
    250,
    { width: 40, height: 40, fill: "#0f172a", stroke: "transparent", strokeWidth: 0, radius: 0 },
  );

  return {
    format: "makefigma-remediation-text-path-structured-fixture-v1",
    viewport: fixture.viewport,
    assets: fixture.assets,
    nodes: [
      background,
      clipFrame,
      clippedTextPath,
      maskGroup,
      maskPanel,
      mask,
      maskedTextPath,
      effectGroup,
      effectPanel,
      effectedTextPath,
      finalMarker,
    ],
  };
}

function structuredTextPath(
  source: CanvasNode,
  id: string,
  name: string,
  parentId: string,
  x: number,
  y: number,
  pointIds: readonly [string, string],
): CanvasNode {
  const node = structuredClone(source);
  const subpath = node.vectorPath?.subpaths[0];
  if (!subpath || subpath.points.length !== pointIds.length)
    throw new Error("Structured TextPath fixture requires one two-point cubic");
  subpath.points.forEach((point, index) => {
    point.id = pointIds[index]!;
  });
  return {
    ...node,
    id,
    name,
    parentId,
    x,
    y,
    relativeTransform: translation(x, y),
  };
}

function paintedNode(
  kind: NodeKind,
  id: string,
  name: string,
  x: number,
  y: number,
  patch: Partial<CanvasNode>,
): CanvasNode {
  const node = { ...createNode(kind, x, y), id, name, ...patch };
  return {
    ...node,
    fillColor:
      patch.fill === undefined ? node.fillColor : documentColorFromCssHex(patch.fill),
    fillGradient: patch.fill === undefined ? node.fillGradient : undefined,
    strokeColor:
      patch.stroke === undefined
        ? node.strokeColor
        : documentColorFromCssHex(patch.stroke),
    strokeGradient: patch.stroke === undefined ? node.strokeGradient : undefined,
  };
}

function translation(e: number, f: number) {
  return { a: 1, b: 0, c: 0, d: 1, e, f };
}
