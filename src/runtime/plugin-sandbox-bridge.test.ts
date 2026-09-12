import { describe, expect, it, vi } from "vitest";
import { PluginSandboxBridge } from "./plugin-sandbox-bridge";
import { PluginSandboxSession, validatePluginManifest } from "./plugin-sandbox";

const manifest = validatePluginManifest({ id: "com.example.review", name: "Review", apiVersion: 1, permissions: ["document:read"] });

describe("M7 plugin message bridge", () => {
  it("accepts only the bound opaque iframe Window and replies with safe envelopes", async () => {
    const target = { postMessage: vi.fn() };
    const session = new PluginSandboxSession(manifest, { handle: async () => ({ accepted: true }) });
    session.start();
    const bridge = new PluginSandboxBridge(session, target);
    expect(await bridge.handleMessage({ source: {}, data: { channel: "makefigma.plugin.v1", pluginId: manifest.id, request: { requestId: "ignored", kind: "document.read" } } })).toBe(false);
    expect(target.postMessage).not.toHaveBeenCalled();
    expect(await bridge.handleMessage({ source: target, data: { channel: "makefigma.plugin.v1", pluginId: manifest.id, request: { requestId: "read", kind: "document.read" } } })).toBe(true);
    expect(target.postMessage).toHaveBeenCalledWith(expect.objectContaining({ requestId: "read", ok: true, result: { accepted: true } }), "*");
  });

  it("hides host error detail from plugin responses", async () => {
    const target = { postMessage: vi.fn() };
    const session = new PluginSandboxSession(manifest, { handle: async () => { throw new Error("host-only context"); } });
    session.start();
    await new PluginSandboxBridge(session, target).handleMessage({ source: target, data: { channel: "makefigma.plugin.v1", pluginId: manifest.id, request: { requestId: "fail", kind: "document.read" } } });
    expect(target.postMessage).toHaveBeenCalledWith(expect.objectContaining({ requestId: "fail", ok: false, errorCode: "INTERNAL_ERROR" }), "*");
  });

  it("counts the opaque-iframe response envelope against the response budget", async () => {
    const target = { postMessage: vi.fn() };
    const session = new PluginSandboxSession(manifest, { handle: async () => ({ text: "x".repeat(960) }) }, { maxResponseBytes: 1_024 });
    session.start();
    await new PluginSandboxBridge(session, target).handleMessage({ source: target, data: { channel: "makefigma.plugin.v1", pluginId: manifest.id, request: { requestId: "read", kind: "document.read" } } });
    expect(target.postMessage).toHaveBeenCalledWith(expect.objectContaining({ requestId: "read", ok: false, errorCode: "RESOURCE_LIMIT" }), "*");
  });
});
