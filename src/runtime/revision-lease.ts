import { runtimeError } from "./runtime-errors";

export type RevisionLeaseResource = Readonly<{
  id: string;
  contentHash: string;
  byteLength: number;
}>;

export type RevisionLease<TProjection, TResource extends RevisionLeaseResource = RevisionLeaseResource> = Readonly<{
  id: string;
  revision: number;
  projection: Readonly<TProjection>;
  resources: readonly Readonly<TResource>[];
  acquiredAtMs: number;
  expiresAtMs?: number;
}>;

export type RevisionLeasePoolOptions = Readonly<{
  maxLeases: number;
  maxUniqueResourceBytes: number;
  maxAgeMs?: number;
  now?: () => number;
  createId?: () => string;
}>;

type ResourceReference = { byteLength: number; references: number };

/**
 * Holds immutable projection and resource references for Player/Export. Derived
 * GPU/text caches are deliberately rebuilt from a lease rather than stored in
 * it, so a Device Lost cannot switch a consumer to a newer document revision.
 */
export class RevisionLeasePool<TProjection, TResource extends RevisionLeaseResource = RevisionLeaseResource> {
  private readonly leases = new Map<string, RevisionLease<TProjection, TResource>>();
  private readonly resourceReferences = new Map<string, ResourceReference>();
  private readonly now: () => number;
  private readonly createId: () => string;
  private readonly maxAgeMs?: number;

  constructor(private readonly options: RevisionLeasePoolOptions) {
    if (!Number.isSafeInteger(options.maxLeases) || options.maxLeases < 1 || !Number.isSafeInteger(options.maxUniqueResourceBytes) || options.maxUniqueResourceBytes < 0) {
      throw runtimeError("INVALID_ARGUMENT");
    }
    this.now = options.now ?? Date.now;
    this.createId = options.createId ?? (() => crypto.randomUUID());
    this.maxAgeMs = options.maxAgeMs;
    if (this.maxAgeMs !== undefined && (!Number.isSafeInteger(this.maxAgeMs) || this.maxAgeMs < 1)) throw runtimeError("INVALID_ARGUMENT");
  }

  acquire(input: Readonly<{ revision: number; projection: TProjection; resources: readonly TResource[] }>): RevisionLease<TProjection, TResource> {
    this.expireLeases();
    if (!Number.isSafeInteger(input.revision) || input.revision < 0 || this.leases.size >= this.options.maxLeases) {
      throw runtimeError("RESOURCE_LIMIT", { revision: input.revision });
    }
    const resources = input.resources.map((resource) => freezeResource(resource));
    const additions = uniqueResourceBytes(resources, this.resourceReferences);
    if (this.uniqueResourceBytes() + additions > this.options.maxUniqueResourceBytes) throw runtimeError("RESOURCE_LIMIT", { revision: input.revision });

    const acquiredAtMs = this.now();
    const lease = Object.freeze({
      id: this.createId(),
      revision: input.revision,
      projection: freezeValue(input.projection),
      resources: Object.freeze(resources),
      acquiredAtMs,
      ...(this.maxAgeMs === undefined ? {} : { expiresAtMs: acquiredAtMs + this.maxAgeMs }),
    }) as RevisionLease<TProjection, TResource>;
    if (this.leases.has(lease.id)) throw runtimeError("INTERNAL_ERROR", { revision: input.revision });
    this.leases.set(lease.id, lease);
    for (const resource of resources) this.retainResource(resource);
    return lease;
  }

  get(leaseId: string): RevisionLease<TProjection, TResource> {
    this.expireLeases();
    const lease = this.leases.get(leaseId);
    if (!lease) throw runtimeError("REVISION_LEASE_EXPIRED");
    return lease;
  }

  release(leaseId: string): void {
    const lease = this.leases.get(leaseId);
    if (!lease) throw runtimeError("REVISION_LEASE_EXPIRED");
    this.leases.delete(leaseId);
    for (const resource of lease.resources) this.releaseResource(resource);
  }

  rebuildDerived<T>(leaseId: string, build: (lease: RevisionLease<TProjection, TResource>) => T): T {
    return build(this.get(leaseId));
  }

  state(): Readonly<{ activeLeaseIds: readonly string[]; uniqueResourceBytes: number }> {
    this.expireLeases();
    return { activeLeaseIds: [...this.leases.keys()], uniqueResourceBytes: this.uniqueResourceBytes() };
  }

  private expireLeases(): void {
    const now = this.now();
    for (const lease of [...this.leases.values()]) {
      if (lease.expiresAtMs !== undefined && lease.expiresAtMs <= now) this.release(lease.id);
    }
  }

  private uniqueResourceBytes(): number {
    return [...this.resourceReferences.values()].reduce((total, reference) => total + reference.byteLength, 0);
  }

  private retainResource(resource: TResource): void {
    const key = resourceKey(resource);
    const current = this.resourceReferences.get(key);
    if (current) {
      current.references += 1;
      return;
    }
    this.resourceReferences.set(key, { byteLength: resource.byteLength, references: 1 });
  }

  private releaseResource(resource: TResource): void {
    const key = resourceKey(resource);
    const current = this.resourceReferences.get(key);
    if (!current) throw runtimeError("INTERNAL_ERROR");
    if (current.references === 1) this.resourceReferences.delete(key);
    else current.references -= 1;
  }
}

function freezeResource<TResource extends RevisionLeaseResource>(resource: TResource): Readonly<TResource> {
  if (!resource.id || !resource.contentHash || !Number.isSafeInteger(resource.byteLength) || resource.byteLength < 0) throw runtimeError("INVALID_ARGUMENT");
  return freezeValue(resource);
}

function uniqueResourceBytes(resources: readonly RevisionLeaseResource[], existing: ReadonlyMap<string, ResourceReference>): number {
  const seen = new Set<string>();
  let bytes = 0;
  for (const resource of resources) {
    const key = resourceKey(resource);
    if (!existing.has(key) && !seen.has(key)) bytes += resource.byteLength;
    seen.add(key);
  }
  return bytes;
}

function resourceKey(resource: RevisionLeaseResource): string {
  return `${resource.id}:${resource.contentHash}`;
}

function freezeValue<T>(value: T): Readonly<T> {
  return deepFreeze(structuredClone(value));
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}
