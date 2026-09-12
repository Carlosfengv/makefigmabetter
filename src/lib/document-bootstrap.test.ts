import { describe, expect, it } from "vitest";
import { coreProjectionNode } from "./transaction-batch";
import { createNode } from "./editor-protocol";
import {
  DEFAULT_PAGE_ID,
  migrateLegacyFigmaBootstrapPage,
} from "./document-bootstrap";

const importedPageId = "00000000-0000-4000-8000-000000000101";
const importedPosition =
  "80000000000000000000000000000000:00000000000000000000000000000000";

function importedNode(pageId = importedPageId) {
  return coreProjectionNode({
    ...createNode("frame", 10, 20),
    id: "00000000-0000-4000-8000-000000000201",
    pageId,
    name: "Imported frame",
    extensions: { "figma.rest.source-id.v1": [49, 58, 49] },
  });
}

function snapshot(nodes = [importedNode()]) {
  return {
    schemaVersion: 21,
    documentId: "00000000-0000-4000-8000-000000000301",
    revision: 1,
    canUndo: false,
    canRedo: false,
    canonicalHash: "old-hash",
    pages: [
      {
        id: DEFAULT_PAGE_ID,
        name: "Page 1",
        positionId:
          "00000000000000000000000000000001:00000000000000000000000000000000",
      },
      { id: importedPageId, name: "Dashboard", positionId: importedPosition },
    ],
    nodes,
  };
}

describe("document bootstrap migration", () => {
  it("adopts the first Figma page when the preset page is empty", () => {
    const migrated = migrateLegacyFigmaBootstrapPage(snapshot());

    expect(migrated?.replacedPageId).toBe(importedPageId);
    expect(migrated?.snapshot.pages).toEqual([
      { id: DEFAULT_PAGE_ID, name: "Dashboard", positionId: importedPosition },
    ]);
    expect(migrated?.snapshot.nodes[0]?.pageId).toBe(DEFAULT_PAGE_ID);
    expect(migrated?.snapshot.canonicalHash).toBe("");
  });

  it("never replaces a Page 1 containing user-authored content", () => {
    const userNode = coreProjectionNode({
      ...createNode("rectangle", 0, 0),
      id: "00000000-0000-4000-8000-000000000202",
      pageId: DEFAULT_PAGE_ID,
      name: "User content",
    });

    expect(
      migrateLegacyFigmaBootstrapPage(snapshot([userNode, importedNode()])),
    ).toBeUndefined();
  });

  it("does not rewrite an ordinary multi-page document", () => {
    const ordinary = importedNode();
    ordinary.extensions = undefined;
    expect(
      migrateLegacyFigmaBootstrapPage(snapshot([ordinary])),
    ).toBeUndefined();
  });

  it("orders imported parents before children for validating hydration", () => {
    const parent = importedNode();
    const child = coreProjectionNode({
      ...createNode("rectangle", 0, 0),
      id: "00000000-0000-4000-8000-000000000203",
      pageId: importedPageId,
      parentId: parent.id,
      name: "Imported child",
      extensions: { "figma.rest.source-id.v1": [49, 58, 50] },
    });
    const migrated = migrateLegacyFigmaBootstrapPage(
      snapshot([child, parent]),
    );

    expect(migrated?.snapshot.nodes.map((node) => node.id)).toEqual([
      parent.id,
      child.id,
    ]);
  });
});
