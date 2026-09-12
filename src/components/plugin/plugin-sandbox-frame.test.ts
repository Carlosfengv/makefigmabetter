import { describe, expect, it } from "vitest";
import { PLUGIN_SANDBOX_ATTRIBUTE, pluginSandboxSrcDoc } from "./plugin-sandbox-frame";
import { validatePluginManifest } from "../../runtime/plugin-sandbox";

describe("plugin sandbox fixture", () => {
  it("keeps plugins opaque-origin and self-contained", () => {
    expect(PLUGIN_SANDBOX_ATTRIBUTE).toBe("allow-scripts");
    expect(PLUGIN_SANDBOX_ATTRIBUTE).not.toContain("allow-same-origin");
    expect(PLUGIN_SANDBOX_ATTRIBUTE).not.toContain("allow-forms");
    expect(PLUGIN_SANDBOX_ATTRIBUTE).not.toContain("allow-popups");
    expect(PLUGIN_SANDBOX_ATTRIBUTE).not.toContain("allow-top-navigation");
  });

  it("emits a local document with a deny-by-default CSP", () => {
    const document = pluginSandboxSrcDoc("<plugin>");
    expect(document).toContain("default-src 'none'");
    expect(document).toContain("connect-src 'none'");
    expect(document).toContain("form-action 'none'");
    expect(document).toContain("\\u003cplugin>");
    expect(document).not.toContain('src="http');
  });

  it("derives its network CSP only from a validated plugin manifest", () => {
    const manifest = validatePluginManifest({ id: "com.example.network", name: "Network fixture", apiVersion: 1, permissions: ["network"], networkDomains: ["api.example.com"] });
    expect(pluginSandboxSrcDoc("network", manifest)).toContain("connect-src https://api.example.com");
  });

  it("loads a validated plugin bundle through the isolated bootstrap", () => {
    const manifest = validatePluginManifest({ id: "com.example.bundle", name: "Bundle fixture", apiVersion: 1, permissions: [] });
    const document = pluginSandboxSrcDoc("bundle", manifest, { pluginId: manifest.id, uiJavaScript: "parent.postMessage({ ready: true }, '*')" });
    expect(document).toContain("atob(encoded)");
    expect(document).not.toContain("parent.postMessage({ ready: true }");
  });
});
