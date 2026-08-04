import { afterEach, describe, expect, it, vi } from "vitest";

type WorkerScope = {
  onmessage?: (event: { data: unknown }) => void;
  postMessage: (message: unknown) => void;
};

const originalSelf = Object.getOwnPropertyDescriptor(globalThis, "self");

async function loadProbeWorker() {
  const messages: unknown[] = [];
  const scope: WorkerScope = { postMessage: (message) => messages.push(message) };
  Object.defineProperty(globalThis, "self", { configurable: true, value: scope });
  vi.resetModules();
  await import("./asset-probe.worker");
  return { scope, messages };
}

function waitForProbe() {
  return new Promise((resolve) => setTimeout(resolve, 10));
}

afterEach(() => {
  if (originalSelf) Object.defineProperty(globalThis, "self", originalSelf);
  else Reflect.deleteProperty(globalThis, "self");
});

describe("Asset Probe Worker", () => {
  it("suppresses inspection results when cancelled before the bounded probe runs", async () => {
    const { scope, messages } = await loadProbeWorker();
    scope.onmessage?.({ data: { type: "probe", requestId: "cancel-me", kind: "svg", declaredMime: "image/svg+xml", bytes: new TextEncoder().encode("<svg/>").buffer } });
    scope.onmessage?.({ data: { type: "cancel", requestId: "cancel-me" } });
    await waitForProbe();

    expect(messages).toEqual([expect.objectContaining({
      type: "cancelled", requestId: "cancel-me", audit: expect.objectContaining({ category: "asset-probe", outcome: "cancelled" }),
    })]);
  });

  it("returns the bounded admission and a privacy-safe audit event for a normal probe", async () => {
    const { scope, messages } = await loadProbeWorker();
    scope.onmessage?.({ data: { type: "probe", requestId: "safe-svg", kind: "svg", declaredMime: "image/svg+xml", bytes: new TextEncoder().encode("<svg/>").buffer } });
    await waitForProbe();

    expect(messages).toEqual([expect.objectContaining({
      type: "result", requestId: "safe-svg", detectedMime: "image/svg+xml", admission: { accepted: true, mime: "image/svg+xml" },
      audit: expect.objectContaining({ schemaVersion: 1, category: "asset-probe", code: "ASSET_PROBE_ACCEPTED", outcome: "accepted", assetKind: "svg" }),
    })]);
    expect(JSON.stringify((messages[0] as { audit: unknown }).audit)).not.toContain("safe-svg");
  });
});
