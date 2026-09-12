import { describe, expect, it } from "vitest";
import { RevisionLeasePool } from "./revision-lease";
import { isRuntimeError } from "./runtime-errors";

describe("RevisionLeasePool", () => {
  it("freezes a projection and rebuilds derived state from the same revision", () => {
    const source = { nodes: [{ id: "frame", x: 0 }] };
    const pool = new RevisionLeasePool<typeof source>({ maxLeases: 2, maxUniqueResourceBytes: 100, createId: () => "lease-1" });
    const lease = pool.acquire({ revision: 4, projection: source, resources: [{ id: "font", contentHash: "f1", byteLength: 40 }] });
    source.nodes[0]!.x = 99;

    expect(lease.projection).toEqual({ nodes: [{ id: "frame", x: 0 }] });
    expect(Object.isFrozen(lease.projection.nodes)).toBe(true);
    expect(Object.isFrozen(lease.projection.nodes[0]!)).toBe(true);
    expect(pool.rebuildDerived(lease.id, (input) => ({ revision: input.revision, nodeX: input.projection.nodes[0]!.x, resource: input.resources[0]!.contentHash }))).toEqual({ revision: 4, nodeX: 0, resource: "f1" });
  });

  it("accounts for shared immutable resources once and releases them by reference", () => {
    let next = 0;
    const pool = new RevisionLeasePool<{ id: string }>({ maxLeases: 2, maxUniqueResourceBytes: 40, createId: () => `lease-${next++}` });
    const resource = { id: "image", contentHash: "hash", byteLength: 40 };
    const first = pool.acquire({ revision: 1, projection: { id: "first" }, resources: [resource] });
    const second = pool.acquire({ revision: 2, projection: { id: "second" }, resources: [resource] });
    expect(pool.state()).toEqual({ activeLeaseIds: [first.id, second.id], uniqueResourceBytes: 40 });
    pool.release(first.id);
    expect(pool.state()).toEqual({ activeLeaseIds: [second.id], uniqueResourceBytes: 40 });
    pool.release(second.id);
    expect(pool.state()).toEqual({ activeLeaseIds: [], uniqueResourceBytes: 0 });
  });

  it("expires a lease rather than silently switching to a later projection", () => {
    let now = 0;
    const pool = new RevisionLeasePool<{ id: string }>({ maxLeases: 1, maxUniqueResourceBytes: 0, maxAgeMs: 10, now: () => now, createId: () => "expiring" });
    const lease = pool.acquire({ revision: 3, projection: { id: "old" }, resources: [] });
    now = 10;
    const error = captureError(() => pool.get(lease.id));
    expect(isRuntimeError(error, "REVISION_LEASE_EXPIRED")).toBe(true);
    expect(pool.state()).toEqual({ activeLeaseIds: [], uniqueResourceBytes: 0 });
  });
});

function captureError(action: () => void): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  throw new Error("Expected action to throw.");
}
