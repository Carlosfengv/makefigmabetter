import type { RuntimeProjection, RuntimeProjectionNode } from "./runtime-projection-store";

export type ComponentVariantResolution = Readonly<{
  instanceId: string;
  componentId: string;
  matched: "exact" | "default" | "fallback";
  requestedProperties: Readonly<Record<string, string | boolean>>;
  diagnostics: readonly Readonly<{ code: "VARIANT_PROPERTY_UNMATCHED" | "VARIANT_TARGET_UNAVAILABLE"; property?: string }> [];
}>;

/** Resolves an INSTANCE's visible component without mutating Canonical state.
 * Variant labels use Figma's `Property=Value, …` component-name convention;
 * unknown values fall back to the linked main component with a diagnostic. */
export function resolveComponentVariant(
  projection: RuntimeProjection,
  instanceId: string,
  properties: Readonly<Record<string, string | boolean>> = instanceProperties(nodeFor(projection, instanceId)),
): ComponentVariantResolution | undefined {
  const instance = nodeFor(projection, instanceId);
  if (!instance || instance.type !== "INSTANCE") return undefined;
  const linkedComponentId = mainComponentId(instance);
  const main = linkedComponentId ? nodeFor(projection, linkedComponentId) : undefined;
  if (!main || main.type !== "COMPONENT") return {
    instanceId,
    componentId: linkedComponentId ?? "",
    matched: "fallback",
    requestedProperties: Object.freeze({ ...properties }),
    diagnostics: Object.freeze([{ code: "VARIANT_TARGET_UNAVAILABLE" }]),
  };
  const set = typeof main.parentId === "string" ? nodeFor(projection, main.parentId) : undefined;
  const candidates = set?.type === "COMPONENT_SET"
    ? projection.nodes.filter((node) => node.removed !== true && node.parentId === set.id && node.type === "COMPONENT")
    : [main];
  const requested = Object.entries(properties).filter(([, value]) => typeof value === "string");
  const exact = candidates.filter((candidate) => requested.every(([key, value]) => variantProperties(candidate)[key] === value));
  if (requested.length && exact.length === 1) return resolution(instanceId, exact[0]!.id, "exact", properties);
  if (!requested.length) return resolution(instanceId, main.id, "default", properties);
  const unmatched = requested.find(([key, value]) => !candidates.some((candidate) => variantProperties(candidate)[key] === value));
  return resolution(instanceId, main.id, "fallback", properties, [{ code: "VARIANT_PROPERTY_UNMATCHED", ...(unmatched ? { property: unmatched[0] } : {}) }]);
}

/** Prevents an interaction from swapping an instance to a component outside
 * its ComponentSet. A standalone linked component is its own only variant. */
export function canChangeInstanceToVariant(projection: RuntimeProjection, instanceId: string, componentId: string): boolean {
  const instance = nodeFor(projection, instanceId);
  const target = nodeFor(projection, componentId);
  const currentId = instance && mainComponentId(instance);
  const current = currentId ? nodeFor(projection, currentId) : undefined;
  if (!instance || instance.type !== "INSTANCE" || !target || target.type !== "COMPONENT" || !current || current.type !== "COMPONENT") return false;
  return current.parentId === target.parentId && (nodeFor(projection, current.parentId ?? "")?.type === "COMPONENT_SET" || current.id === target.id);
}

export function instanceAncestor(projection: RuntimeProjection, nodeId: string): RuntimeProjectionNode | undefined {
  let current = nodeFor(projection, nodeId);
  const visited = new Set<string>();
  while (current && !visited.has(current.id)) {
    if (current.type === "INSTANCE") return current;
    visited.add(current.id);
    current = typeof current.parentId === "string" ? nodeFor(projection, current.parentId) : undefined;
  }
  return undefined;
}

function resolution(instanceId: string, componentId: string, matched: ComponentVariantResolution["matched"], properties: Readonly<Record<string, string | boolean>>, diagnostics: ComponentVariantResolution["diagnostics"] = []) {
  return Object.freeze({ instanceId, componentId, matched, requestedProperties: Object.freeze({ ...properties }), diagnostics: Object.freeze([...diagnostics]) });
}
function nodeFor(projection: RuntimeProjection, id: string | undefined): RuntimeProjectionNode | undefined { return projection.nodes.find((node) => node.id === id && node.removed !== true); }
function mainComponentId(node: RuntimeProjectionNode | undefined): string | undefined { return typeof (node?.instanceMetadata as { mainComponentId?: unknown } | undefined)?.mainComponentId === "string" ? (node!.instanceMetadata as { mainComponentId: string }).mainComponentId : undefined; }
function instanceProperties(node: RuntimeProjectionNode | undefined): Record<string, string | boolean> {
  const properties = (node?.instanceMetadata as { componentProperties?: unknown } | undefined)?.componentProperties;
  return properties && typeof properties === "object"
    ? Object.fromEntries(Object.entries(properties).filter((entry): entry is [string, string | boolean] => typeof entry[1] === "string" || typeof entry[1] === "boolean"))
    : {};
}
function variantProperties(component: RuntimeProjectionNode): Record<string, string> {
  const name = typeof component.name === "string" ? component.name : "";
  return Object.fromEntries(name.split(",").map((part) => part.trim().split("=")).flatMap(([key, value]) => key?.trim() && value?.trim() ? [[key.trim(), value.trim()]] : []));
}
