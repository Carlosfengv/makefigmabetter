import { describe, expect, it } from "vitest";
import { FigmaCompatibleRuntime } from "./figma-compatible-runtime";
import { RuntimeSession } from "./runtime-session";
import type { RuntimeTransactionResult, RuntimeTransactionTransport } from "./runtime-transaction-client";
import type { PendingProjectionTransaction, RuntimeProjection } from "./runtime-projection-store";

describe("FigmaCompatibleRuntime", () => {
  it("exposes the M1 Figma-shaped entry while keeping commit as an explicit project extension", async () => {
    const runtime = new FigmaCompatibleRuntime(new RuntimeSession({
      sessionId: "facade",
      projection: {
        revision: 0,
        nodes: [
          { id: "document", type: "DOCUMENT", name: "Document" },
          { id: "page", type: "PAGE", name: "Page", parentId: "document" },
        ],
      },
      transport: new NoopTransport(),
      createId: () => "rectangle",
      scheduleMicrotask: () => {},
    }));

    const rectangle = runtime.createRectangle();
    rectangle.x = 18;
    expect(runtime.currentPage.children).toEqual([rectangle]);
    expect(await runtime.commitAsync()).toBe(1);
    expect((await runtime.getNodeByIdAsync("rectangle"))?.x).toBe(18);
  });

  it("exposes one stable Figma mixed sentinel for asymmetric endpoint caps", async () => {
    const runtime = new FigmaCompatibleRuntime(new RuntimeSession({
      sessionId: "mixed-stroke-cap",
      projection: {
        revision: 0,
        nodes: [
          { id: "document", type: "DOCUMENT", name: "Document" },
          { id: "page", type: "PAGE", name: "Page", parentId: "document" },
          {
            id: "line",
            type: "LINE",
            name: "Asymmetric line",
            parentId: "page",
            siblingIndex: 0,
            strokeCapStart: "round",
            strokeCapEnd: "triangleFilled",
          },
        ],
      },
      transport: new NoopTransport(),
      scheduleMicrotask: () => {},
    }));

    const line = await runtime.getNodeByIdAsync("line");
    expect(line?.strokeCap).toBe(runtime.mixed);
    expect(runtime.mixed).toBe(runtime.mixed);
  });
});

class NoopTransport implements RuntimeTransactionTransport {
  async submit(transaction: PendingProjectionTransaction): Promise<RuntimeTransactionResult> {
    const nodes = new Map<string, RuntimeProjection["nodes"][number]>([
      ["document", { id: "document", type: "DOCUMENT", name: "Document" }],
      ["page", { id: "page", type: "PAGE", name: "Page", parentId: "document" }],
    ]);
    for (const operation of transaction.operations) {
      if (operation.type === "create") nodes.set(operation.node.id, operation.node);
      if (operation.type === "update") {
        const node = nodes.get(operation.nodeId);
        if (node) nodes.set(operation.nodeId, { ...node, ...operation.patch });
      }
    }
    const projection: RuntimeProjection = {
      revision: 1,
      nodes: [...nodes.values()],
    };
    return { type: "accepted", acceptedRevision: 1, projection };
  }
}
