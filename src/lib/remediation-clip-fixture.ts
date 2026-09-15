import { createNode, documentColorFromCssHex, type CanvasNode, type NodeKind, type Viewport } from "./editor-protocol";

export const REMEDIATION_CLIP_FIXTURE_NAME = "RF-03-RF-04-CONTAINER-CLIP";

export interface RemediationClipFixture {
  format: "makefigma-remediation-clip-fixture-v1";
  name: typeof REMEDIATION_CLIP_FIXTURE_NAME;
  viewport: Viewport;
  nodes: CanvasNode[];
}

const ids = {
  background: "00000000-0000-4000-8000-000000000400",
  frame: "00000000-0000-4000-8000-000000000401",
  frameChild: "00000000-0000-4000-8000-000000000402",
  component: "00000000-0000-4000-8000-000000000403",
  componentChild: "00000000-0000-4000-8000-000000000404",
  instance: "00000000-0000-4000-8000-000000000405",
  instanceChild: "00000000-0000-4000-8000-000000000406",
  slot: "00000000-0000-4000-8000-000000000407",
  slotChild: "00000000-0000-4000-8000-000000000408",
  componentSet: "00000000-0000-4000-8000-000000000409",
  componentSetChild: "00000000-0000-4000-8000-00000000040a",
  disjointOuter: "00000000-0000-4000-8000-00000000040b",
  disjointInner: "00000000-0000-4000-8000-00000000040c",
  disjointTarget: "00000000-0000-4000-8000-00000000040d",
  affineFrame: "00000000-0000-4000-8000-00000000040e",
  affineChild: "00000000-0000-4000-8000-00000000040f",
  reflectedSkewFrame: "00000000-0000-4000-8000-000000000410",
  reflectedSkewChild: "00000000-0000-4000-8000-000000000411",
} as const;

export function createRemediationClipFixture(): RemediationClipFixture {
  const background = fixtureNode("rectangle", ids.background, "Evidence background", -360, -240, {
    width: 720,
    height: 480,
    fill: "#ffffff",
    stroke: "transparent",
    strokeWidth: 0,
    radius: 0,
  });

  const panels: Array<Readonly<{ kind: "frame" | "component" | "instance" | "slot"; id: string; childId: string; x: number; color: string }>> = [
    { kind: "frame", id: ids.frame, childId: ids.frameChild, x: -300, color: "#ef4444" },
    { kind: "component", id: ids.component, childId: ids.componentChild, x: -150, color: "#3b82f6" },
    { kind: "instance", id: ids.instance, childId: ids.instanceChild, x: 0, color: "#22c55e" },
    { kind: "slot", id: ids.slot, childId: ids.slotChild, x: 150, color: "#f59e0b" },
  ];
  const panelNodes = panels.flatMap(({ kind, id, childId, x, color }) => {
    const parent = fixtureNode(kind, id, `${kind} clip`, x, -180, containerPaint());
    const child = fixtureNode("rectangle", childId, `${kind} overflow child`, 70, 20, {
      parentId: parent.id,
      relativeTransform: translation(70, 20),
      width: 80,
      height: 70,
      fill: color,
      stroke: "transparent",
      strokeWidth: 0,
      radius: 0,
    });
    return [parent, child];
  });

  const componentSet = fixtureNode("componentSet", ids.componentSet, "componentSet clip", -300, 20, containerPaint());
  const componentSetChild = fixtureNode("component", ids.componentSetChild, "componentSet overflow component", 70, 20, {
    parentId: componentSet.id,
    relativeTransform: translation(70, 20),
    width: 80,
    height: 70,
    fill: "#a855f7",
    stroke: "transparent",
    strokeWidth: 0,
    radius: 0,
  });

  const disjointOuter = fixtureNode("frame", ids.disjointOuter, "Disjoint outer clip", -100, 20, {
    ...containerPaint(),
    fill: "transparent",
  });
  const disjointInner = fixtureNode("frame", ids.disjointInner, "Disjoint inner clip", 150, 0, {
    parentId: disjointOuter.id,
    relativeTransform: translation(150, 0),
    width: 100,
    height: 100,
    fill: "transparent",
    stroke: "transparent",
    strokeWidth: 0,
    radius: 0,
    clipsContent: true,
  });
  const disjointTarget = fixtureNode("rectangle", ids.disjointTarget, "Must remain fully clipped", -150, 20, {
    parentId: disjointInner.id,
    relativeTransform: translation(-150, 20),
    width: 100,
    height: 60,
    fill: "#7c3aed",
    stroke: "transparent",
    strokeWidth: 0,
    radius: 0,
  });

  const cosine = Math.SQRT1_2;
  const affineFrame = fixtureNode("frame", ids.affineFrame, "Rotated rounded clip", 100, 20, {
    ...containerPaint(),
    relativeTransform: { a: cosine, b: cosine, c: -cosine, d: cosine, e: 100, f: 20 },
    radius: 20,
    cornerSmoothing: 0.35,
  });
  const affineChild = fixtureNode("rectangle", ids.affineChild, "Affine clip target", -40, -40, {
    parentId: affineFrame.id,
    relativeTransform: translation(-40, -40),
    width: 190,
    height: 190,
    fill: "#06b6d4",
    stroke: "transparent",
    strokeWidth: 0,
    radius: 0,
  });

  const reflectedSkewFrame = fixtureNode("frame", ids.reflectedSkewFrame, "Reflected skew clip", 330, 70, {
    ...containerPaint(),
    width: 90,
    height: 100,
    relativeTransform: { a: -1, b: .2, c: .35, d: 1, e: 330, f: 70 },
    radius: 16,
    cornerSmoothing: 0.5,
  });
  const reflectedSkewChild = fixtureNode("rectangle", ids.reflectedSkewChild, "Reflected skew target", -30, -30, {
    parentId: reflectedSkewFrame.id,
    relativeTransform: translation(-30, -30),
    width: 150,
    height: 160,
    fill: "#ec4899",
    stroke: "transparent",
    strokeWidth: 0,
    radius: 0,
  });

  return {
    format: "makefigma-remediation-clip-fixture-v1",
    name: REMEDIATION_CLIP_FIXTURE_NAME,
    viewport: { x: 0, y: 0, zoom: 1 },
    nodes: [
      background,
      ...panelNodes,
      componentSet,
      componentSetChild,
      disjointOuter,
      disjointInner,
      disjointTarget,
      affineFrame,
      affineChild,
      reflectedSkewFrame,
      reflectedSkewChild,
    ],
  };
}

function containerPaint(): Partial<CanvasNode> {
  return {
    width: 110,
    height: 110,
    fill: "#00000000",
    stroke: "#111827",
    strokeWidth: 4,
    strokeAlign: "inside",
    radius: 12,
    clipsContent: true,
  };
}

function translation(e: number, f: number) {
  return { a: 1, b: 0, c: 0, d: 1, e, f };
}

function fixtureNode(kind: NodeKind, id: string, name: string, x: number, y: number, patch: Partial<CanvasNode>): CanvasNode {
  const node = { ...createNode(kind, x, y), id, name, ...patch };
  return {
    ...node,
    fillColor: patch.fill === undefined ? node.fillColor : documentColorFromCssHex(patch.fill),
    fillGradient: patch.fill === undefined ? node.fillGradient : undefined,
    strokeColor: patch.stroke === undefined ? node.strokeColor : documentColorFromCssHex(patch.stroke),
    strokeGradient: patch.stroke === undefined ? node.strokeGradient : undefined,
  };
}

export const REMEDIATION_CLIP_FIXTURE_IDS = ids;
