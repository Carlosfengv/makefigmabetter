import { describe, expect, it } from "vitest";
import { compileScene } from "../runtime/scene-compiler";
import { resizeFigmaPluginTableTrack, setFigmaPluginSlideTransition, writeFigmaPluginNode } from "./figma-plugin-node-mutation";
import { createM6SpecialNodesFixture, M6_SPECIAL_NODES_FIXTURE_NAME, M6_SPECIAL_NODES_PAGE_ID } from "./m6-special-nodes-fixture";
import { exportPageToSvg } from "./svg-export";
import { resolveCoreBatch } from "./transaction-batch";

describe("F-M6-SPECIAL-NODES fixture", () => {
  it("covers every M6 family through the Canonical create and editing paths", () => {
    const fixture = createM6SpecialNodesFixture();
    const byKind = (kind: string) => fixture.nodes.find((node) => node.kind === kind)!;
    expect(fixture).toMatchObject({ format: "makefigma-m6-special-nodes-fixture-v1", name: M6_SPECIAL_NODES_FIXTURE_NAME });
    expect(fixture.nodes.map((node) => node.kind)).toEqual(expect.arrayContaining(["connector", "shapeWithText", "sticky", "table", "tableCell", "media", "embed", "linkUnfurl", "textPath", "transformGroup", "slideGrid", "slideRow", "slide", "interactiveSlideElement"]));
    expect(resolveCoreBatch([], fixture.nodes.map((node) => ({ type: "create" as const, node })))?.nextNodes).toHaveLength(fixture.nodes.length);
    expect(writeFigmaPluginNode(byKind("connector"), { connectorLineType: "CURVED" }).ok).toBe(true);
    expect(writeFigmaPluginNode(byKind("shapeWithText"), { shapeType: "HEXAGON" }).ok).toBe(true);
    expect(writeFigmaPluginNode(byKind("sticky"), { stickyText: "Edited insight", authorVisible: false }).ok).toBe(true);
    expect(resizeFigmaPluginTableTrack(byKind("table"), "column", 0, 220).ok).toBe(true);
    expect(setFigmaPluginSlideTransition(byKind("slide"), { style: "DISSOLVE", duration: .3, curve: "EASE_IN", timing: { type: "ON_CLICK" } }).ok).toBe(true);
  });

  it("compiles static primitives and explicitly identifies every unsafe advanced behavior", () => {
    const fixture = createM6SpecialNodesFixture();
    const scene = compileScene({ revision: 6, nodes: fixture.nodes, pageId: M6_SPECIAL_NODES_PAGE_ID, defaultPageId: M6_SPECIAL_NODES_PAGE_ID });
    const semantic = new Map(scene.scene.semanticNodes.map((node) => [node.nodeId, node]));
    expect(semantic.get(fixture.nodes.find((node) => node.kind === "sticky")!.id)?.paintable).toBe(true);
    expect(semantic.get(fixture.nodes.find((node) => node.kind === "transformGroup")!.id)?.paintable).toBe(false);
    expect(scene.diagnostics.filter((diagnostic) => diagnostic.capability === "special-node").map((diagnostic) => diagnostic.nodeId)).toEqual(expect.arrayContaining([
      fixture.nodes.find((node) => node.kind === "media")!.id,
      fixture.nodes.find((node) => node.kind === "embed")!.id,
      fixture.nodes.find((node) => node.kind === "linkUnfurl")!.id,
      fixture.nodes.find((node) => node.kind === "transformGroup")!.id,
      fixture.nodes.find((node) => node.kind === "interactiveSlideElement")!.id,
    ]));
  });

  it("exports the same fixture with machine-readable special-node fallbacks", () => {
    const fixture = createM6SpecialNodesFixture();
    const result = exportPageToSvg(fixture.nodes, { pageId: M6_SPECIAL_NODES_PAGE_ID, defaultPageId: M6_SPECIAL_NODES_PAGE_ID, padding: 0 });
    expect(result.svg).toContain("<svg");
    expect(result.svg).toContain('d="M 0 0 L 110 0 L 220 0"');
    expect(result.svg).toContain('d="M 90 0 L 180 55 L 90 110 L 0 55 Z"');
    expect(result.svg).toContain(">Approve</tspan>");
    expect(result.svg).toContain(">User insight</tspan>");
    expect(result.svg).toContain(">Scope</tspan>");
    expect(result.svg).toContain(">Media preview</text>");
    expect(result.svg).toContain(">Prototype</text>");
    expect(result.svg).toContain(">Launch notes</text>");
    expect(result.svg).toContain(">Poll interaction</text>");
    expect(result.compatibilityFallbacks.filter((fallback) => fallback.capability === "special-node").map((fallback) => fallback.nodeId)).toEqual(expect.arrayContaining([
      ...fixture.nodes.filter((node) => ["media", "embed", "linkUnfurl", "interactiveSlideElement"].includes(node.kind)).map((node) => node.id),
    ]));
  });
});
