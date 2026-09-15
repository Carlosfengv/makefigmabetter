import {
  createNode,
  documentColorFromCssHex,
  type CanvasNode,
  type ConstraintType,
  type Viewport,
} from "./editor-protocol";

const FRAME_ID = "00000000-0000-4000-8000-000000009001";
let sequence = 9001;

function child(
  name: string,
  x: number,
  y: number,
  width: number,
  height: number,
  horizontal: ConstraintType,
  vertical: ConstraintType,
  fill: string,
): CanvasNode {
  sequence += 1;
  const draft = createNode("rectangle", x, y);
  return {
    ...draft,
    id: `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`,
    parentId: FRAME_ID,
    positionId: `000000000000000000000000000090${String(sequence).slice(-2)}:00000000000000000000000000000000`,
    name,
    x,
    y,
    width,
    height,
    fill,
    fillColor: documentColorFromCssHex(fill),
    stroke: "transparent",
    strokeColor: undefined,
    strokeWidth: 0,
    radius: 8,
    constraints: { horizontal, vertical },
    relativeTransform: { a: 1, b: 0, c: 0, d: 1, e: x, f: y },
  };
}

export function createConstraintParityFixture(): { nodes: CanvasNode[]; viewport: Viewport } {
  sequence = 9001;
  const frame: CanvasNode = {
    ...createNode("frame", -320, -210),
    id: FRAME_ID,
    name: "Constraint playground",
    width: 640,
    height: 420,
    fill: "#ffffff",
    fillColor: documentColorFromCssHex("#ffffff"),
    stroke: "#b7beca",
    strokeColor: documentColorFromCssHex("#b7beca"),
    radius: 0,
    clipsContent: true,
  };
  return {
    viewport: { x: 0, y: 0, zoom: 1 },
    nodes: [
      frame,
      child("Left · Top", 32, 32, 128, 56, "min", "min", "#dbeafe"),
      child("Center · Center", 256, 182, 128, 56, "center", "center", "#ede9fe"),
      child("Right · Bottom", 480, 332, 128, 56, "max", "max", "#dcfce7"),
      child("Left & right", 32, 116, 576, 40, "stretch", "min", "#fef3c7"),
      child("Scale", 220, 268, 200, 40, "scale", "scale", "#ffe4e6"),
    ],
  };
}
