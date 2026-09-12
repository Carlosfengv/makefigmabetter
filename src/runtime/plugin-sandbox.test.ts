import { describe, expect, it, vi } from "vitest";
import { isRuntimeError } from "./runtime-errors";
import { PluginSandboxSession, pluginSandboxContentSecurityPolicy, validatePluginManifest } from "./plugin-sandbox";

const manifest = validatePluginManifest({ id: "com.example.review", name: "Review", apiVersion: 1, permissions: ["document:read", "network"], networkDomains: ["api.example.com"] });

describe("M7 plugin sandbox", () => {
  it("keeps a manifest allowlist and an opaque-origin-compatible CSP", () => {
    expect(pluginSandboxContentSecurityPolicy(manifest)).toContain("connect-src https://api.example.com");
    expect(() => validatePluginManifest({ ...manifest, permissions: ["network"], networkDomains: ["*.example.com"] })).toThrow();
    expect(() => validatePluginManifest({ ...manifest, permissions: ["document:read"] as const, networkDomains: ["api.example.com"] })).toThrow();
  });

  it("gates every request, binds network hosts and closes in-flight work", async () => {
    const aborted = vi.fn();
    const host = { handle: vi.fn(async (request, signal: AbortSignal) => { signal.addEventListener("abort", aborted); return { accepted: request.kind }; }) };
    const session = new PluginSandboxSession(manifest, host);
    await expect(session.request({ requestId: "before-start", kind: "document.read" })).rejects.toSatisfy((error: unknown) => isRuntimeError(error, "RESOURCE_UNAVAILABLE"));
    session.start();
    await expect(session.request({ requestId: "read", kind: "document.read" })).resolves.toEqual({ accepted: "document.read" });
    await expect(session.request({ requestId: "write", kind: "document.write" })).rejects.toSatisfy((error: unknown) => isRuntimeError(error, "PERMISSION_DENIED"));
    await expect(session.request({ requestId: "wrong-host", kind: "network.fetch", payload: { url: "https://evil.example/" } })).rejects.toSatisfy((error: unknown) => isRuntimeError(error, "PERMISSION_DENIED"));
    await expect(session.request({ requestId: "right-host", kind: "network.fetch", payload: { url: "https://api.example.com/v1" } })).resolves.toEqual({ accepted: "network.fetch" });
    await expect(session.receiveMessage({ channel: "makefigma.plugin.v1", pluginId: manifest.id, request: { requestId: "envelope", kind: "document.read" } })).resolves.toEqual({ accepted: "document.read" });
    await expect(session.receiveMessage({ channel: "makefigma.plugin.v1", pluginId: "com.example.other", request: { requestId: "cross-plugin", kind: "document.read" } })).rejects.toSatisfy((error: unknown) => isRuntimeError(error, "PERMISSION_DENIED"));
    session.close();
    expect(() => session.start()).toThrow();
  });

  it("aborts requests that exceed their manifest-scoped host timeout", async () => {
    let expire: (() => void) | undefined;
    const session = new PluginSandboxSession(manifest, { handle: async (_request, signal) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")))) }, { setTimer: (callback) => { expire = callback; return 1 as unknown as ReturnType<typeof setTimeout>; }, clearTimer: vi.fn() });
    session.start();
    const result = session.request({ requestId: "slow", kind: "document.read" });
    expire?.();
    await expect(result).rejects.toSatisfy((error: unknown) => isRuntimeError(error, "TIMEOUT"));
  });

  it("settles in-flight work when closed even if the host ignores cancellation", async () => {
    const session = new PluginSandboxSession(manifest, { handle: async () => new Promise(() => undefined) });
    session.start();
    const result = session.request({ requestId: "ignores-abort", kind: "document.read" });
    session.close();
    await expect(result).rejects.toSatisfy((error: unknown) => isRuntimeError(error, "RUNTIME_CLOSED"));
  });

  it("bounds concurrent host work and releases capacity once a request settles", async () => {
    let release: (() => void) | undefined;
    let calls = 0;
    const session = new PluginSandboxSession(manifest, { handle: async () => {
      calls += 1;
      if (calls > 1) return;
      return new Promise<void>((resolve) => { release = resolve; });
    } }, { maxPendingRequests: 1 });
    session.start();
    const first = session.request({ requestId: "first", kind: "document.read" });
    await expect(session.request({ requestId: "second", kind: "document.read" })).rejects.toSatisfy((error: unknown) => isRuntimeError(error, "RESOURCE_LIMIT"));
    release?.();
    await first;
    await expect(session.request({ requestId: "third", kind: "document.read" })).resolves.toBeUndefined();
  });

  it("rejects oversized complete request and response envelopes at the sandbox boundary", async () => {
    const requestSession = new PluginSandboxSession(manifest, { handle: async () => ({ accepted: true }) }, { maxRequestBytes: 1_024 });
    requestSession.start();
    await expect(requestSession.request({ requestId: "too-large-request", kind: "document.read", payload: { text: "x".repeat(2_000) } })).rejects.toSatisfy((error: unknown) => isRuntimeError(error, "RESOURCE_LIMIT"));

    const responseSession = new PluginSandboxSession(manifest, { handle: async () => ({ text: "x".repeat(2_000) }) }, { maxResponseBytes: 1_024 });
    responseSession.start();
    await expect(responseSession.request({ requestId: "too-large-response", kind: "document.read" })).rejects.toSatisfy((error: unknown) => isRuntimeError(error, "RESOURCE_LIMIT"));

    await expect(requestSession.receiveMessage({ channel: "makefigma.plugin.v1", pluginId: manifest.id, request: { requestId: "too-large-envelope", kind: "document.read", payload: { text: "x".repeat(2_000) } } })).rejects.toSatisfy((error: unknown) => isRuntimeError(error, "RESOURCE_LIMIT"));
  });

  it("limits sustained Host work with a bounded sliding request window", async () => {
    let now = 0;
    const session = new PluginSandboxSession(manifest, { handle: async () => ({ accepted: true }) }, { maxRequestsPerWindow: 2, requestWindowMs: 1_000, now: () => now });
    session.start();
    await expect(session.request({ requestId: "one", kind: "document.read" })).resolves.toEqual({ accepted: true });
    await expect(session.request({ requestId: "two", kind: "document.read" })).resolves.toEqual({ accepted: true });
    await expect(session.request({ requestId: "three", kind: "document.read" })).rejects.toSatisfy((error: unknown) => isRuntimeError(error, "RESOURCE_LIMIT"));
    now = 1_000;
    await expect(session.request({ requestId: "after-window", kind: "document.read" })).resolves.toEqual({ accepted: true });
  });

  it("makes completed request IDs single-use without retaining an unbounded replay ledger", async () => {
    const handle = vi.fn(async () => ({ accepted: true }));
    const session = new PluginSandboxSession(manifest, { handle }, { maxRememberedRequestIds: 1 });
    session.start();
    await expect(session.request({ requestId: "write-once", kind: "document.read" })).resolves.toEqual({ accepted: true });
    await expect(session.request({ requestId: "write-once", kind: "document.read" })).rejects.toSatisfy((error: unknown) => isRuntimeError(error, "INVALID_ARGUMENT"));
    expect(handle).toHaveBeenCalledTimes(1);

    await expect(session.request({ requestId: "next", kind: "document.read" })).resolves.toEqual({ accepted: true });
    await expect(session.request({ requestId: "write-once", kind: "document.read" })).resolves.toEqual({ accepted: true });
    expect(handle).toHaveBeenCalledTimes(3);

    const failingHandle = vi.fn(async () => { throw new Error("host failure"); });
    const failing = new PluginSandboxSession(manifest, { handle: failingHandle });
    failing.start();
    await expect(failing.request({ requestId: "failed-once", kind: "document.read" })).rejects.toThrow("host failure");
    await expect(failing.request({ requestId: "failed-once", kind: "document.read" })).rejects.toSatisfy((error: unknown) => isRuntimeError(error, "INVALID_ARGUMENT"));
    expect(failingHandle).toHaveBeenCalledTimes(1);
  });
});
