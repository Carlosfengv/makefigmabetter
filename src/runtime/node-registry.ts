import { runtimeError } from "./runtime-errors";

export type RuntimeNodeHandle = Readonly<{
  sessionId: string;
  nodeId: string;
  generation: number;
}>;

type Entry<TProxy> = {
  generation: number;
  live: boolean;
  proxy?: TProxy;
};

/** Keeps object identity local to one RuntimeSession. A canonical ID that is
 * deleted and later restored receives a new generation, so stale references
 * cannot mutate its Undo-restored successor. */
export class NodeRegistry<TProxy> {
  private readonly entries = new Map<string, Entry<TProxy>>();

  constructor(private readonly sessionId: string) {}

  reconcile(liveNodeIds: readonly string[]): void {
    const live = new Set(liveNodeIds);
    for (const [nodeId, entry] of this.entries) {
      if (!live.has(nodeId)) entry.live = false;
    }
    for (const nodeId of live) {
      const entry = this.entries.get(nodeId);
      if (!entry) {
        this.entries.set(nodeId, { generation: 1, live: true });
      } else if (!entry.live) {
        entry.generation += 1;
        entry.live = true;
        entry.proxy = undefined;
      }
    }
  }

  get(nodeId: string, create: (handle: RuntimeNodeHandle) => TProxy): TProxy {
    let entry = this.entries.get(nodeId);
    if (!entry) {
      entry = { generation: 1, live: true };
      this.entries.set(nodeId, entry);
    }
    if (!entry.live) throw runtimeError("NODE_REMOVED", { nodeId });
    if (!entry.proxy) entry.proxy = create(Object.freeze({ sessionId: this.sessionId, nodeId, generation: entry.generation }));
    return entry.proxy;
  }

  isCurrent(handle: RuntimeNodeHandle): boolean {
    const entry = this.entries.get(handle.nodeId);
    return entry?.live === true && entry.generation === handle.generation && handle.sessionId === this.sessionId;
  }

  generation(nodeId: string): number | undefined {
    return this.entries.get(nodeId)?.generation;
  }
}
