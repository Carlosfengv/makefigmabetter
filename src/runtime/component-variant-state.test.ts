import { describe, expect, it } from "vitest";
import { canChangeInstanceToVariant, resolveComponentVariant } from "./component-variant-state";
import type { RuntimeProjection } from "./runtime-projection-store";

function projection(): RuntimeProjection {
  return { revision: 1, nodes: [
    { id: "set", type: "COMPONENT_SET" },
    { id: "default", type: "COMPONENT", parentId: "set", name: "State=Default, Size=Small" },
    { id: "hover", type: "COMPONENT", parentId: "set", name: "State=Hover, Size=Small" },
    { id: "instance", type: "INSTANCE", instanceMetadata: { mainComponentId: "default", componentProperties: { State: "Hover", Size: "Small", Enabled: true } } },
  ] };
}

describe("M5 component variant state", () => {
  it("resolves an instance's requested ComponentSet variant and preserves non-variant properties", () => {
    expect(resolveComponentVariant(projection(), "instance")).toMatchObject({ componentId: "hover", matched: "exact", requestedProperties: { State: "Hover", Size: "Small", Enabled: true } });
  });

  it("uses a diagnosable main-component fallback and rejects cross-set swaps", () => {
    const source = projection();
    (source.nodes.find((node) => node.id === "instance")!.instanceMetadata as { componentProperties: Record<string, string> }).componentProperties = { State: "Pressed" };
    expect(resolveComponentVariant(source, "instance")).toMatchObject({ componentId: "default", matched: "fallback", diagnostics: [{ code: "VARIANT_PROPERTY_UNMATCHED", property: "State" }] });
    source.nodes.push({ id: "other", type: "COMPONENT", name: "State=Hover" });
    expect(canChangeInstanceToVariant(source, "instance", "hover")).toBe(true);
    expect(canChangeInstanceToVariant(source, "instance", "other")).toBe(false);
  });
});
