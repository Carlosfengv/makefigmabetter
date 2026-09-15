import { describe, expect, it } from "vitest";
import { canonicalConnectorEndpoint, FIGMA_CONNECTOR_STROKE_CAPS, isFigmaConnectorStrokeCap, projectFigmaConnectorEndpoint } from "./connector-endpoint";

describe("Figma Connector endpoint adapter", () => {
  it("round-trips the three official endpoint variants", () => {
    const fallback = { x: 12, y: 18 };
    expect(canonicalConnectorEndpoint({ position: { x: 4, y: 5 } }, fallback)).toEqual({ x: 4, y: 5 });
    expect(canonicalConnectorEndpoint({ endpointNodeId: "1:2", position: { x: 6, y: 7 } }, fallback)).toEqual({ endpointNodeId: "1:2", x: 6, y: 7 });
    expect(canonicalConnectorEndpoint({ endpointNodeId: "1:2", magnet: "RIGHT" }, fallback)).toEqual({ endpointNodeId: "1:2", magnet: "RIGHT", x: 12, y: 18 });

    expect(projectFigmaConnectorEndpoint({ x: 4, y: 5 })).toEqual({ position: { x: 4, y: 5 } });
    expect(projectFigmaConnectorEndpoint({ endpointNodeId: "1:2", x: 6, y: 7 })).toEqual({ endpointNodeId: "1:2", position: { x: 6, y: 7 } });
    expect(projectFigmaConnectorEndpoint({ endpointNodeId: "1:2", magnet: "RIGHT", x: 12, y: 18 })).toEqual({ endpointNodeId: "1:2", magnet: "RIGHT" });
  });

  it("preserves every official magnet while rejecting malformed writes", () => {
    const fallback = { x: 12, y: 18 };
    expect(canonicalConnectorEndpoint({ x: 4, y: 5 }, fallback)).toBeUndefined();
    expect(canonicalConnectorEndpoint({ position: { x: Number.NaN, y: 5 } }, fallback)).toBeUndefined();
    expect(canonicalConnectorEndpoint({ endpointNodeId: "1:2", position: { x: 4, y: 5 }, magnet: "RIGHT" }, fallback)).toBeUndefined();
    expect(canonicalConnectorEndpoint({ endpointNodeId: "1:2", magnet: "NONE" }, fallback)).toEqual({ endpointNodeId: "1:2", magnet: "NONE", x: 12, y: 18 });
    expect(canonicalConnectorEndpoint({ endpointNodeId: "1:2", magnet: "CENTER" }, fallback)).toEqual({ endpointNodeId: "1:2", magnet: "CENTER", x: 12, y: 18 });
    expect(canonicalConnectorEndpoint({ endpointNodeId: "1:2", magnet: "FUTURE" }, fallback)).toBeUndefined();
    expect(projectFigmaConnectorEndpoint({ endpointNodeId: "1:2", magnet: "CENTER", x: 12, y: 18 })).toEqual({ endpointNodeId: "1:2", magnet: "CENTER" });
  });

  it("uses the exact current ConnectorStrokeCap vocabulary", () => {
    expect(FIGMA_CONNECTOR_STROKE_CAPS).toHaveLength(12);
    expect(FIGMA_CONNECTOR_STROKE_CAPS).toContain("ERD_ONE_OR_MORE");
    expect(isFigmaConnectorStrokeCap("ARROW_LINES")).toBe(true);
    expect(isFigmaConnectorStrokeCap("FUTURE_CAP")).toBe(false);
  });
});
