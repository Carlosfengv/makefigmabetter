import { describe, expect, it } from "vitest";
import fixture from "../../fixtures/documents/remediation-non-linear-gradient.fixture.json";

describe("W12-P non-linear gradient fixture", () => {
  it("contains one valid radial, angular and diamond Canonical Paint Stack", () => {
    const gradients = fixture.nodes.flatMap((node) => "fillStack" in node
      ? node.fillStack.layers.flatMap((layer) => layer.paint.gradientPaint ? [layer.paint.gradientPaint] : [])
      : []);
    expect(gradients.map((gradient) => gradient.kind)).toEqual(["radial", "angular", "diamond"]);
    expect(gradients.every((gradient) => {
      const transform = gradient.transform;
      return Math.abs(transform.a * transform.d - transform.b * transform.c) > 1e-12
        && gradient.stops.length >= 2
        && gradient.stops.every((stop, index) => stop.position >= 0 && stop.position <= 1 && (index === 0 || stop.position >= gradient.stops[index - 1]!.position));
    })).toBe(true);
  });
});
