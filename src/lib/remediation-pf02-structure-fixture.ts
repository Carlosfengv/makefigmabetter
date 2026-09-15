import type { CanvasNode, Viewport } from "./editor-protocol";

export const REMEDIATION_PF02_100K_NODE_COUNT = 100_000;
export const REMEDIATION_PF02_LAYOUT_CHILD_COUNT = 9_999;
export const REMEDIATION_PF02_LAYOUT_FRAME_ID =
  "53000000-0000-4000-8000-000000000001";
export const REMEDIATION_PF02_VIEWPORT: Viewport = { x: 0, y: 0, zoom: 1 };

export interface RemediationPf02StructureFixture {
  nodes: CanvasNode[];
  viewport: Viewport;
}

export interface RemediationPf02LayoutCascadeFixture
  extends RemediationPf02StructureFixture {
  frameId: string;
  layoutChildren: number;
  targetWidth: number;
}

/**
 * Builds complete Group + child pairs so every 1,024-node WASM hydration batch
 * is structurally valid on its own. The native PF-02 benchmark additionally
 * covers BooleanOperation; this browser fixture isolates children-index and
 * WASM heap cost without asking the renderer to flatten live Boolean geometry.
 */
export function createRemediationPf02StructureFixture(
  nodeCount = REMEDIATION_PF02_100K_NODE_COUNT,
): RemediationPf02StructureFixture {
  if (!Number.isSafeInteger(nodeCount) || nodeCount <= 0 || nodeCount % 2 !== 0) {
    throw new Error("INVALID_REMEDIATION_PF02_NODE_COUNT");
  }
  const nodes: CanvasNode[] = [];
  for (let pair = 0; pair < nodeCount / 2; pair += 1) {
    const groupId = fixtureId(pair * 2);
    const column = pair % 500;
    const row = Math.floor(pair / 500);
    nodes.push({
      id: groupId,
      name: `PF-02 Group ${pair + 1}`,
      kind: "group",
      x: column * 24,
      y: row * 24,
      width: 16,
      height: 16,
      rotation: 0,
      fill: "transparent",
      stroke: "transparent",
      strokeWidth: 0,
      radius: 0,
      opacity: 1,
      visible: true,
    });
    nodes.push({
      id: fixtureId(pair * 2 + 1),
      parentId: groupId,
      name: `PF-02 Child ${pair + 1}`,
      kind: "rectangle",
      x: column * 24,
      y: row * 24,
      width: 16,
      height: 16,
      rotation: 0,
      fill: "#0048ff",
      stroke: "transparent",
      strokeWidth: 0,
      radius: 2,
      opacity: 1,
      visible: true,
    });
  }
  return { nodes, viewport: { ...REMEDIATION_PF02_VIEWPORT } };
}

/** Builds a 100k-node document with 9,999 direct children under one Frame.
 * The Frame starts without Auto Layout so batch hydration remains linear; the
 * Worker enables SPACE_BETWEEN once, then measures a width-change cascade. */
export function createRemediationPf02LayoutCascadeFixture(
  nodeCount = REMEDIATION_PF02_100K_NODE_COUNT,
  layoutChildren = REMEDIATION_PF02_LAYOUT_CHILD_COUNT,
): RemediationPf02LayoutCascadeFixture {
  if (
    !Number.isSafeInteger(nodeCount) ||
    !Number.isSafeInteger(layoutChildren) ||
    nodeCount < layoutChildren + 1 ||
    layoutChildren <= 0 ||
    layoutChildren > REMEDIATION_PF02_LAYOUT_CHILD_COUNT
  ) {
    throw new Error("INVALID_REMEDIATION_PF02_LAYOUT_SIZE");
  }

  const nodes: CanvasNode[] = [
    {
      id: REMEDIATION_PF02_LAYOUT_FRAME_ID,
      name: "PF-02 cascade frame",
      kind: "frame",
      x: 0,
      y: 0,
      width: 200_000,
      height: 100,
      rotation: 0,
      fill: "transparent",
      stroke: "transparent",
      strokeWidth: 0,
      radius: 0,
      opacity: 1,
      visible: true,
      clipsContent: false,
    },
  ];

  for (let index = 0; index < layoutChildren; index += 1) {
    nodes.push({
      id: layoutFixtureId(index + 2),
      parentId: REMEDIATION_PF02_LAYOUT_FRAME_ID,
      name: `PF-02 cascade child ${index + 1}`,
      kind: "rectangle",
      x: 0,
      y: 0,
      width: 10,
      height: 10,
      rotation: 0,
      fill: "#ffffff",
      stroke: "transparent",
      strokeWidth: 0,
      radius: 0,
      opacity: 1,
      visible: true,
    });
  }

  for (let index = layoutChildren + 1; index < nodeCount; index += 1) {
    nodes.push({
      id: layoutFixtureId(index + 1),
      name: `PF-02 unrelated root ${index - layoutChildren}`,
      kind: "rectangle",
      x: 300_000 + (index % 500) * 20,
      y: Math.floor(index / 500) * 20,
      width: 10,
      height: 10,
      rotation: 0,
      fill: "#ffffff",
      stroke: "transparent",
      strokeWidth: 0,
      radius: 0,
      opacity: 1,
      visible: true,
    });
  }

  return {
    nodes,
    viewport: { ...REMEDIATION_PF02_VIEWPORT },
    frameId: REMEDIATION_PF02_LAYOUT_FRAME_ID,
    layoutChildren,
    targetWidth: 210_000,
  };
}

function fixtureId(index: number): string {
  return `52000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
}

function layoutFixtureId(index: number): string {
  return `53000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
}
