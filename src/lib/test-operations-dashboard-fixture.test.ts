import { describe, expect, it } from "vitest";
import { transformPoint, worldTransformForNode } from "./scene-transform";
import { createTestOperationsDashboardFixture } from "./test-operations-dashboard-fixture";

describe("test operations dashboard fixture", () => {
  it("is a populated Canvas document with inspectable hierarchy", () => {
    const fixture = createTestOperationsDashboardFixture();
    const root = fixture.nodes.find((node) => node.kind === "frame");
    expect(root).toMatchObject({ name: "测试运营后台 Dashboard · 1440", width: 1280, height: 800 });
    expect(fixture.nodes).toHaveLength(92);
    expect(fixture.nodes.filter((node) => node.parentId === root?.id)).toHaveLength(91);
    expect(fixture.nodes.filter((node) => node.kind === "text").map((node) => node.name)).toEqual(expect.arrayContaining([
      "Page heading", "KPI value · 运行通过率", "Trend title", "Attention title",
    ]));
  });

  it("uses parent-local transforms and canonical paints for a clipped Frame", () => {
    const fixture = createTestOperationsDashboardFixture();
    const root = fixture.nodes.find((node) => node.kind === "frame")!;
    const sidebar = fixture.nodes.find((node) => node.name === "Sidebar")!;
    const heading = fixture.nodes.find((node) => node.name === "Page heading")!;
    expect(sidebar.relativeTransform).toEqual({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
    expect(transformPoint(worldTransformForNode(fixture.nodes, sidebar.id)!, { x: 0, y: 0 })).toEqual({ x: root.x, y: root.y });
    expect(transformPoint(worldTransformForNode(fixture.nodes, heading.id)!, { x: 0, y: 0 })).toEqual({ x: root.x + 250, y: root.y + 130 });
    expect(sidebar.fillColor).toEqual({ space: "srgb", components: [23 / 255, 32 / 255, 51 / 255], alpha: 1 });
    expect(root.fillColor).toEqual({ space: "srgb", components: [245 / 255, 247 / 255, 251 / 255], alpha: 1 });
  });
});
