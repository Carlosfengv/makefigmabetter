import { afterEach, describe, expect, it, vi } from "vitest";

function browserWindow() {
  const events = new EventTarget();
  const values = new Map<string, string>();
  return {
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events),
    dispatchEvent: events.dispatchEvent.bind(events),
    localStorage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
      removeItem: (key: string) => { values.delete(key); },
      clear: () => values.clear(),
    },
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("workspace save queue", () => {
  it("stops queued stale catalogue writes after a version conflict", async () => {
    vi.resetModules();
    vi.stubGlobal("window", browserWindow());
    if (typeof CustomEvent === "undefined") {
      vi.stubGlobal("CustomEvent", class<T> extends Event { constructor(type: string, init: CustomEventInit<T>) { super(type); Object.defineProperty(this, "detail", { value: init.detail }); } });
    }
    const store = await import("./workspace-store");
    const initial = store.createSeedWorkspace(store.DEMO_WORKSPACE_KEY);
    const latest = { ...initial, revision: 2 };
    const fetch = vi.fn(async () => new Response(JSON.stringify(latest), { status: 409 }));
    vi.stubGlobal("fetch", fetch);
    const conflicts: unknown[] = [];
    window.addEventListener("makefigma:workspace-conflict", (event) => conflicts.push((event as CustomEvent).detail));

    store.saveWorkspace({ ...initial, name: "first" });
    store.saveWorkspace({ ...initial, name: "second" });

    await expect(store.flushWorkspaceSave(initial.key)).rejects.toMatchObject({ code: "WORKSPACE_CONFLICT" });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(conflicts).toEqual([latest]);
  });

  it("does not fall back to a local cache while recovering a failed write", async () => {
    vi.resetModules();
    vi.stubGlobal("window", browserWindow());
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("offline"); }));
    const store = await import("./workspace-store");
    expect(await store.fetchWorkspace(store.DEMO_WORKSPACE_KEY, { allowCachedFallback: false })).toBeUndefined();
  });
});
