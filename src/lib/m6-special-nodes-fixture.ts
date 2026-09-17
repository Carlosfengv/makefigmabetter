import { createNode, documentColorFromCssHex, type CanvasNode, type Viewport } from "./editor-protocol";

export const M6_SPECIAL_NODES_FIXTURE_NAME = "F-M6-SPECIAL-NODES";
export const M6_SPECIAL_NODES_PAGE_ID = "00000000-0000-4000-8000-00000000a601";

export type M6SpecialNodesFixture = Readonly<{
  format: "makefigma-m6-special-nodes-fixture-v1";
  name: typeof M6_SPECIAL_NODES_FIXTURE_NAME;
  viewport: Viewport;
  nodes: CanvasNode[];
}>;

/** A byte-free, deterministic M6 evidence surface.  It intentionally contains
 * no remote payload: Media/Embed/LinkUnfurl are expected to render their safe
 * local previews and to produce explicit compatibility records. */
export function createM6SpecialNodesFixture(): M6SpecialNodesFixture {
  const connector = node("connector", "00000000-0000-4000-8000-00000000a602", "Elbow connector", 40, 40, {
    width: 220, stroke: "#334155", strokeWidth: 3,
    connectorMetadata: { ...createNode("connector", 0, 0).connectorMetadata!, lineType: "ELBOWED", end: { x: 220, y: 0, magnet: "AUTO" }, text: "Routes to review" },
  });
  const shape = node("shapeWithText", "00000000-0000-4000-8000-00000000a603", "Decision", 320, 30, {
    width: 180, height: 110, fill: "#e0e7ff", stroke: "#4f46e5", text: "Approve", shapeWithTextType: "DIAMOND",
  });
  const sticky = node("sticky", "00000000-0000-4000-8000-00000000a604", "Research note", 540, 30, {
    text: "User insight", stickyMetadata: { authorVisible: true, authorName: "M6", isWideWidth: false },
  });
  const table = node("table", "00000000-0000-4000-8000-00000000a605", "Delivery grid", 40, 220, {
    width: 360, height: 160, tableMetadata: { columnWidths: [180, 180], rowHeights: [80, 80] },
  });
  const cells = [
    node("tableCell", "00000000-0000-4000-8000-00000000a606", "Scope cell", 0, 0, { parentId: table.id, width: 180, height: 80, text: "Scope", tableCellMetadata: { rowIndex: 0, columnIndex: 0 } }),
    node("tableCell", "00000000-0000-4000-8000-00000000a607", "State cell", 180, 0, { parentId: table.id, width: 180, height: 80, text: "Ready", tableCellMetadata: { rowIndex: 0, columnIndex: 1 } }),
    node("tableCell", "00000000-0000-4000-8000-00000000a608", "Owner cell", 0, 80, { parentId: table.id, width: 180, height: 80, text: "Owner", tableCellMetadata: { rowIndex: 1, columnIndex: 0 } }),
    node("tableCell", "00000000-0000-4000-8000-00000000a609", "Team cell", 180, 80, { parentId: table.id, width: 180, height: 80, text: "Design", tableCellMetadata: { rowIndex: 1, columnIndex: 1 } }),
  ];
  const media = node("media", "00000000-0000-4000-8000-00000000a610", "Demo media", 440, 220, { width: 220, height: 124, mediaMetadata: { hash: "m6-demo-media" } });
  const embed = node("embed", "00000000-0000-4000-8000-00000000a611", "Prototype embed", 700, 220, {
    width: 220, height: 124, embedMetadata: { srcUrl: "https://example.com/embed", canonicalUrl: "https://example.com/embed", title: "Prototype", description: "Interactive prototype", provider: "Example" },
  });
  const unfurl = node("linkUnfurl", "00000000-0000-4000-8000-00000000a612", "Launch link", 960, 220, {
    width: 220, height: 124, linkUnfurlMetadata: { url: "https://example.com/launch", title: "Launch notes", description: "M6 safe preview", provider: "Example" },
  });
  const textPath = node("textPath", "00000000-0000-4000-8000-00000000a613", "Curve label", 440, 410, { width: 260, height: 100, text: "Text follows this path" });
  const transform = node("transformGroup", "00000000-0000-4000-8000-00000000a614", "Repeated motif", 760, 410, {
    width: 140, height: 90, transformModifiers: [{ type: "REPEAT", count: 3, unitType: "RELATIVE", offset: 1.25, repeatType: "LINEAR", axis: "HORIZONTAL" }],
  });
  const transformSource = node("rectangle", "00000000-0000-4000-8000-00000000a615", "Repeated source", 0, 0, { parentId: transform.id, width: 140, height: 90, fill: "#fbbf24", stroke: "#b45309" });
  const slideGrid = node("slideGrid", "00000000-0000-4000-8000-00000000a616", "Slide grid", 0, 0, { width: 1, height: 1 });
  const slideRow = node("slideRow", "00000000-0000-4000-8000-00000000a617", "Slide row", 0, 0, { parentId: slideGrid.id, width: 1, height: 1 });
  const slide = node("slide", "00000000-0000-4000-8000-00000000a618", "M6 slide", 40, 560, { parentId: slideRow.id, width: 1920, height: 1080, fill: "#ffffff", stroke: "#cbd5e1" });
  const slideInteraction = node("interactiveSlideElement", "00000000-0000-4000-8000-00000000a619", "Slide poll", 120, 120, { parentId: slide.id, width: 360, height: 180, interactiveSlideElementType: "POLL" });

  return { format: "makefigma-m6-special-nodes-fixture-v1", name: M6_SPECIAL_NODES_FIXTURE_NAME, viewport: { x: 0, y: 0, zoom: 1 }, nodes: [connector, shape, sticky, table, ...cells, media, embed, unfurl, textPath, transform, transformSource, slideGrid, slideRow, slide, slideInteraction] };
}

function node(kind: CanvasNode["kind"], id: string, name: string, x: number, y: number, patch: Partial<CanvasNode>): CanvasNode {
  const created = { ...createNode(kind, x, y), id, name, pageId: M6_SPECIAL_NODES_PAGE_ID, ...patch };
  return {
    ...created,
    fillColor: patch.fill === undefined ? created.fillColor : documentColorFromCssHex(patch.fill),
    strokeColor: patch.stroke === undefined ? created.strokeColor : documentColorFromCssHex(patch.stroke),
  };
}
