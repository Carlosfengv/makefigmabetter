import type { CanvasNode } from "./editor-protocol";

const POSITION_MAX = (1n << 128n) - 1n;
const LOCAL_ACTOR = "00000000000000000000000000000007";

export type LayerOrderAction = "front" | "back" | "forward" | "backward";

export type LayerOrderResult = {
  /** Back-to-front (paint) order for the active sibling collection. */
  orderedIds: string[];
  /** Concrete canonical keys to commit in one transaction. */
  positionIds: Map<string, string>;
};

/**
 * The document paints siblings back-to-front. The Layers panel deliberately
 * renders this order in reverse, so its first row is always visually topmost.
 */
export function sortNodesByLayerOrder<T extends Pick<CanvasNode, "id" | "positionId">>(nodes: readonly T[]): T[] {
  // Sorting an empty or singleton projection must not require synthesizing a
  // canonical position from a possibly legacy/non-UUID presentation ID.
  if (nodes.length < 2) return [...nodes];
  return nodes
    .map((node) => ({ node, position: parsePositionId(positionIdFor(node)) }))
    .sort(
      (left, right) =>
        compareParsedPositionId(left.position, right.position) ||
        left.node.id.localeCompare(right.node.id),
    )
    .map(({ node }) => node);
}

export function orderNewLayerAtFront(nodes: readonly CanvasNode[], nodeId: string): string | undefined {
  // A legacy presentation projection may not yet carry Core's canonical
  // sibling keys. Its visual order is still usable, but inventing a midpoint
  // from only some keys can duplicate an occupied Core key. Use the new node's
  // deterministic, collision-free Core fallback until the next bridge sync
  // supplies the complete sibling key set.
  if (nodes.some((node) => !node.positionId)) return positionIdFromNodeId(nodeId);
  const ordered = sortNodesByLayerOrder(nodes);
  return allocatePosition(ordered.at(-1)?.positionId, undefined, 1)?.[0] ?? positionIdFromNodeId(nodeId);
}

/** Resolves an order action without mutating document or presentation arrays. */
export function resolveLayerOrder(nodes: readonly CanvasNode[], selectedIds: readonly string[], action: LayerOrderAction): LayerOrderResult | undefined {
  const selected = new Set(selectedIds);
  if (!selected.size || [...selected].some((id) => !nodes.some((node) => node.id === id))) return undefined;
  const ordered = sortNodesByLayerOrder(nodes);
  const moving = ordered.filter((node) => selected.has(node.id));
  const remaining = ordered.filter((node) => !selected.has(node.id));
  if (!moving.length || !remaining.length) return undefined;

  const first = ordered.findIndex((node) => selected.has(node.id));
  const last = ordered.length - 1 - [...ordered].reverse().findIndex((node) => selected.has(node.id));
  let destination: number;
  if (action === "front") destination = remaining.length;
  else if (action === "back") destination = 0;
  else if (action === "forward") {
    if (last === ordered.length - 1) return undefined;
    const next = ordered.slice(last + 1).find((node) => !selected.has(node.id));
    destination = next ? remaining.findIndex((node) => node.id === next.id) + 1 : remaining.length;
  } else {
    if (first === 0) return undefined;
    const previous = [...ordered.slice(0, first)].reverse().find((node) => !selected.has(node.id));
    destination = previous ? remaining.findIndex((node) => node.id === previous.id) : 0;
  }
  return insertAt(remaining, moving, destination);
}

/** Drops the selected sibling block directly before `beforeId`; omit it for front. */
export function resolveLayerDrop(nodes: readonly CanvasNode[], selectedIds: readonly string[], beforeId?: string): LayerOrderResult | undefined {
  const selected = new Set(selectedIds);
  if (!selected.size || (beforeId !== undefined && (!nodes.some((node) => node.id === beforeId) || selected.has(beforeId)))) return undefined;
  const ordered = sortNodesByLayerOrder(nodes);
  const moving = ordered.filter((node) => selected.has(node.id));
  const remaining = ordered.filter((node) => !selected.has(node.id));
  if (!moving.length) return undefined;
  const destination = beforeId ? remaining.findIndex((node) => node.id === beforeId) : remaining.length;
  return insertAt(remaining, moving, destination < 0 ? remaining.length : destination);
}

function insertAt(remaining: CanvasNode[], moving: CanvasNode[], destination: number): LayerOrderResult | undefined {
  const next = [...remaining.slice(0, destination), ...moving, ...remaining.slice(destination)];
  const left = next[destination - 1]?.positionId;
  const right = next[destination + moving.length]?.positionId;
  const allocated = allocatePosition(left, right, moving.length);
  // A repeated insert can exhaust a sparse gap. Re-space this sibling set in
  // the same atomic command rather than permitting an unstable array fallback.
  const positions = allocated ?? evenlySpacedPositions(next.length);
  const positionIds = new Map<string, string>();
  next.forEach((node, index) => {
    const value = allocated ? (selectedIndex(index, destination, moving.length) ? allocated[index - destination] : node.positionId) : positions[index];
    if (value && value !== node.positionId) positionIds.set(node.id, value);
  });
  return positionIds.size ? { orderedIds: next.map((node) => node.id), positionIds } : undefined;
}

function selectedIndex(index: number, destination: number, count: number) { return index >= destination && index < destination + count; }

function allocatePosition(left: string | undefined, right: string | undefined, count: number): string[] | undefined {
  const lower = left ? parsePositionId(left).key : 0n;
  const upper = right ? parsePositionId(right).key : POSITION_MAX;
  const gap = upper - lower;
  if (gap <= BigInt(count)) return undefined;
  const step = gap / BigInt(count + 1);
  if (step === 0n) return undefined;
  return Array.from({ length: count }, (_, index) => formatPositionId(lower + step * BigInt(index + 1)));
}

function evenlySpacedPositions(count: number) {
  return Array.from({ length: count }, (_, index) => formatPositionId(POSITION_MAX * BigInt(index + 1) / BigInt(count + 1)));
}

function positionIdFor(node: Pick<CanvasNode, "id" | "positionId">) { return node.positionId ?? positionIdFromNodeId(node.id); }
function positionIdFromNodeId(id: string) { return `${id.replaceAll("-", "").toLowerCase()}:${"00000000000000000000000000000000"}`; }
function formatPositionId(key: bigint) { return `${key.toString(16).padStart(32, "0")}:${LOCAL_ACTOR}`; }

function parsePositionId(value: string) {
  const [rawKey = "", rawActor = ""] = value.split(":");
  const key = rawKey.replaceAll("-", "");
  const actor = rawActor.replaceAll("-", "");
  if (!/^[0-9a-f]{32}$/i.test(key) || !/^[0-9a-f]{32}$/i.test(actor)) throw new TypeError("Invalid layer position ID.");
  return { key: BigInt(`0x${key}`), actor: BigInt(`0x${actor}`) };
}

function compareParsedPositionId(
  a: ReturnType<typeof parsePositionId>,
  b: ReturnType<typeof parsePositionId>,
) {
  return a.key < b.key ? -1 : a.key > b.key ? 1 : a.actor < b.actor ? -1 : a.actor > b.actor ? 1 : 0;
}
