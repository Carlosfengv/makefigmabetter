import type { RuntimeProjection, RuntimeProjectionNode } from "./runtime-projection-store";

export type SmartAnimateMatch = "component-source" | "structure" | "name" | "unmatched";
export type SmartAnimateLayerKind = "interpolate" | "enter" | "exit";

export type SmartAnimateLayer = Readonly<{
  kind: SmartAnimateLayerKind;
  match: SmartAnimateMatch;
  fromNodeId?: string;
  toNodeId?: string;
  properties: Readonly<{
    x: number;
    y: number;
    width: number;
    height: number;
    rotation: number;
    opacity: number;
    fill?: string;
  }>;
}>;

export type SmartAnimateRenderPlan = Readonly<{
  fromFrameId: string;
  toFrameId: string;
  progress: number;
  layers: readonly SmartAnimateLayer[];
  diagnostics: readonly Readonly<{ code: "UNMATCHED_SOURCE_LAYER" | "UNMATCHED_DESTINATION_LAYER"; nodeId: string }> [];
}>;

/**
 * First Smart Animate slice: match layer identity before interpolating the
 * common geometry/opacity/fill subset. It intentionally has no live-editor
 * dependency: a Player supplies the same RevisionLease projection used for
 * navigation. Ambiguous or incompatible layers become explicit enter/exit
 * layers, never a plausible but incorrect morph.
 */
export function smartAnimateRenderPlan(
  projection: RuntimeProjection,
  fromFrameId: string,
  toFrameId: string,
  progress: number,
): SmartAnimateRenderPlan {
  const fromFrame = nodeFor(projection, fromFrameId);
  const toFrame = nodeFor(projection, toFrameId);
  if (!isAnimateRoot(fromFrame) || !isAnimateRoot(toFrame)) throw new Error("Smart Animate requires two compatible animation roots.");
  const normalizedProgress = clamp(progress);
  const from = animatableLayers(projection, fromFrameId);
  const to = animatableLayers(projection, toFrameId);
  const matches = matchLayers(from, to);
  const matchedFromIds = new Set(matches.map((match) => match.from.node.id));
  const layers: SmartAnimateLayer[] = [];
  const diagnostics: Array<{ code: "UNMATCHED_SOURCE_LAYER" | "UNMATCHED_DESTINATION_LAYER"; nodeId: string }> = [];

  // Paint exits first, then destination-ordered interpolation/entries. This
  // makes repeated input deterministic and gives the destination screen the
  // final stacking order at progress 1.
  from.filter((node) => !matchedFromIds.has(node.node.id)).forEach((node) => {
    layers.push({ kind: "exit", match: "unmatched", fromNodeId: node.node.id, properties: { ...interpolate(node.node, node.node, 0), opacity: numberFor(node.node, "opacity", 1) * (1 - normalizedProgress) } });
    diagnostics.push({ code: "UNMATCHED_SOURCE_LAYER", nodeId: node.node.id });
  });
  to.forEach((target) => {
    const matched = matches.find((match) => match.to.node.id === target.node.id);
    if (matched) {
      layers.push({
        kind: "interpolate",
        match: matched.match,
        fromNodeId: matched.from.node.id,
        toNodeId: target.node.id,
        properties: interpolate(matched.from.node, target.node, normalizedProgress),
      });
      return;
    }
    layers.push({ kind: "enter", match: "unmatched", toNodeId: target.node.id, properties: { ...interpolate(target.node, target.node, 1), opacity: numberFor(target.node, "opacity", 1) * normalizedProgress } });
    diagnostics.push({ code: "UNMATCHED_DESTINATION_LAYER", nodeId: target.node.id });
  });

  return Object.freeze({
    fromFrameId,
    toFrameId,
    progress: normalizedProgress,
    layers: Object.freeze(layers.map((layer) => Object.freeze({ ...layer, properties: Object.freeze(layer.properties) }))),
    diagnostics: Object.freeze(diagnostics.map((diagnostic) => Object.freeze(diagnostic))),
  });
}

type LayerIdentity = Readonly<{ node: RuntimeProjectionNode; structureKey: string; nameKey: string; componentSourceId?: string }>;
type LayerMatch = Readonly<{ from: LayerIdentity; to: LayerIdentity; match: Exclude<SmartAnimateMatch, "unmatched"> }>;

function animatableLayers(projection: RuntimeProjection, frameId: string): LayerIdentity[] {
  const byId = new Map(projection.nodes.filter((node) => node.removed !== true).map((node) => [node.id, node]));
  const paths = new Map<string, string>();
  const orderedChildren = (parentId: string) => [...byId.values()]
    .filter((node) => node.parentId === parentId)
    .sort((left, right) => siblingIndex(left) - siblingIndex(right) || left.id.localeCompare(right.id));
  const visit = (parentId: string, path: string) => {
    const occurrences = new Map<string, number>();
    orderedChildren(parentId).forEach((node) => {
      const label = `${node.type}:${nameOf(node)}`;
      const occurrence = occurrences.get(label) ?? 0;
      occurrences.set(label, occurrence + 1);
      const childPath = `${path}/${label}[${occurrence}]`;
      paths.set(node.id, childPath);
      visit(node.id, childPath);
    });
  };
  visit(frameId, "");
  return [...paths.keys()].flatMap((id): LayerIdentity[] => {
    const node = byId.get(id);
    return node && node.visible !== false && isAnimatable(node) ? [{ node, structureKey: paths.get(id)!, nameKey: `${node.type}:${nameOf(node)}`, componentSourceId: componentSourceId(node) }] : [];
  });
}

function matchLayers(from: readonly LayerIdentity[], to: readonly LayerIdentity[]): LayerMatch[] {
  const remainingFrom = new Set(from.map((node) => node.node.id));
  const remainingTo = new Set(to.map((node) => node.node.id));
  const result: LayerMatch[] = [];
  const matchUnique = (key: (layer: LayerIdentity) => string | undefined, match: LayerMatch["match"]) => {
    const fromByKey = uniqueByKey(from.filter((layer) => remainingFrom.has(layer.node.id)), key);
    const toByKey = uniqueByKey(to.filter((layer) => remainingTo.has(layer.node.id)), key);
    for (const [value, source] of fromByKey) {
      const target = toByKey.get(value);
      if (!target || !compatible(source.node, target.node)) continue;
      remainingFrom.delete(source.node.id); remainingTo.delete(target.node.id);
      result.push({ from: source, to: target, match });
    }
  };
  matchUnique((layer) => layer.componentSourceId, "component-source");
  matchUnique((layer) => layer.structureKey, "structure");
  matchUnique((layer) => layer.nameKey, "name");
  return result;
}

function uniqueByKey(layers: readonly LayerIdentity[], key: (layer: LayerIdentity) => string | undefined): Map<string, LayerIdentity> {
  const grouped = new Map<string, LayerIdentity[]>();
  layers.forEach((layer) => {
    const value = key(layer);
    if (!value) return;
    const values = grouped.get(value) ?? [];
    values.push(layer); grouped.set(value, values);
  });
  return new Map([...grouped.entries()].flatMap(([value, values]) => values.length === 1 ? [[value, values[0]!]] : []));
}

function interpolate(from: RuntimeProjectionNode, to: RuntimeProjectionNode, progress: number): SmartAnimateLayer["properties"] {
  const opacity = numberFor(from, "opacity", 1) + (numberFor(to, "opacity", 1) - numberFor(from, "opacity", 1)) * progress;
  return {
    x: lerp(numberFor(from, "x"), numberFor(to, "x"), progress),
    y: lerp(numberFor(from, "y"), numberFor(to, "y"), progress),
    width: lerp(numberFor(from, "width"), numberFor(to, "width"), progress),
    height: lerp(numberFor(from, "height"), numberFor(to, "height"), progress),
    rotation: lerp(numberFor(from, "rotation"), numberFor(to, "rotation"), progress),
    opacity,
    ...(interpolateColor(stringFor(from, "fill"), stringFor(to, "fill"), progress) ? { fill: interpolateColor(stringFor(from, "fill"), stringFor(to, "fill"), progress)! } : {}),
  };
}

function compatible(from: RuntimeProjectionNode, to: RuntimeProjectionNode): boolean {
  return from.type === to.type && stringFor(from, "kind") === stringFor(to, "kind");
}
function isAnimatable(node: RuntimeProjectionNode): boolean { return node.type !== "FRAME" && node.type !== "SLIDE" && ["x", "y", "width", "height"].every((key) => Number.isFinite(node[key])); }
function isAnimateRoot(node: RuntimeProjectionNode | undefined): boolean { return node?.type === "FRAME" || node?.type === "SLIDE" || node?.type === "COMPONENT" || node?.type === "INSTANCE"; }
function nodeFor(projection: RuntimeProjection, id: string): RuntimeProjectionNode | undefined { return projection.nodes.find((node) => node.id === id && node.removed !== true); }
function siblingIndex(node: RuntimeProjectionNode): number { return typeof node.siblingIndex === "number" && Number.isFinite(node.siblingIndex) ? node.siblingIndex : Number.MAX_SAFE_INTEGER; }
function nameOf(node: RuntimeProjectionNode): string { return typeof node.name === "string" ? node.name : ""; }
function stringFor(node: RuntimeProjectionNode, key: string): string { return typeof node[key] === "string" ? node[key] as string : ""; }
function numberFor(node: RuntimeProjectionNode, key: string, fallback = 0): number { return typeof node[key] === "number" && Number.isFinite(node[key]) ? node[key] as number : fallback; }
function clamp(value: number): number { return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 1; }
function lerp(from: number, to: number, progress: number): number { return from + (to - from) * progress; }

function componentSourceId(node: RuntimeProjectionNode): string | undefined {
  const bytes = (node.extensions as Record<string, unknown> | undefined)?.["figma.instance.source-node.v1"];
  if (!Array.isArray(bytes) || bytes.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)) return undefined;
  const value = new TextDecoder().decode(Uint8Array.from(bytes));
  return value || undefined;
}

function interpolateColor(from: string, to: string, progress: number): string | undefined {
  const start = hexColor(from); const end = hexColor(to);
  if (!start || !end) return progress < .5 ? (from || undefined) : (to || undefined);
  return `#${[0, 1, 2].map((index) => Math.round(lerp(start[index]!, end[index]!, progress)).toString(16).padStart(2, "0")).join("")}`;
}

function hexColor(value: string): [number, number, number] | undefined {
  const compact = /^#([0-9a-f]{3})$/i.exec(value);
  const full = /^#([0-9a-f]{6})$/i.exec(value);
  const hex = compact ? compact[1]!.split("").map((part) => part.repeat(2)).join("") : full?.[1];
  return hex ? [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)] : undefined;
}
