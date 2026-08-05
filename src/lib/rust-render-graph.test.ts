import { describe, expect, it } from "vitest";
import { orderNodesByRustRenderGraph, parseRustRenderGraphPlan, RUST_RENDER_PASSES } from "./rust-render-graph";

const plan = (commands: unknown) => JSON.stringify({ documentRevision: 7, fullScene: true, passes: RUST_RENDER_PASSES, commands });

describe("Rust render graph boundary", () => {
  it("accepts the complete fixed pass list and orders a culled subset by pass", () => {
    const parsed = parseRustRenderGraphPlan(plan([
      { nodeId: "shape", pass: "mainScene" },
      { nodeId: "image", pass: "images" },
      { nodeId: "text", pass: "text" },
    ]));
    expect(orderNodesByRustRenderGraph([{ id: "text" }, { id: "shape" }, { id: "image" }], parsed).map(({ id }) => id)).toEqual(["shape", "image", "text"]);
  });

  it("rejects malformed data and preserves local nodes when a plan omits one", () => {
    expect(parseRustRenderGraphPlan(plan([{ nodeId: "shape", pass: "bad" }]))).toBeUndefined();
    expect(parseRustRenderGraphPlan(JSON.stringify({ documentRevision: 7, fullScene: true, passes: ["text"], commands: [] }))).toBeUndefined();
    const parsed = parseRustRenderGraphPlan(plan([{ nodeId: "shape", pass: "mainScene" }]));
    expect(orderNodesByRustRenderGraph([{ id: "unknown" }, { id: "shape" }], parsed).map(({ id }) => id)).toEqual(["shape", "unknown"]);
  });

  it("keeps a 100k-node plan while sorting only the visible viewport subset", () => {
    const commands = Array.from({ length: 100_000 }, (_, index) => ({
      nodeId: `node-${index}`,
      pass: index % 3 === 0 ? "mainScene" : index % 3 === 1 ? "images" : "text",
    }));
    const parsed = parseRustRenderGraphPlan(plan(commands));
    expect(parsed?.commands).toHaveLength(100_000);
    expect(orderNodesByRustRenderGraph([
      { id: "node-99999" }, { id: "node-4" }, { id: "node-3" }, { id: "node-5" },
    ], parsed).map(({ id }) => id)).toEqual(["node-3", "node-99999", "node-4", "node-5"]);
  });
});
