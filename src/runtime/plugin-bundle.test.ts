import { describe, expect, it } from "vitest";
import { MAX_PLUGIN_BUNDLE_BYTES, pluginBundleBootstrap, validatePluginBundle } from "./plugin-bundle";
import { validatePluginManifest } from "./plugin-sandbox";

const manifest = validatePluginManifest({ id: "com.example.bundle", name: "Bundle", apiVersion: 1, permissions: [] });

describe("M7 plugin bundle", () => {
  it("admits only a bounded bundle addressed to its manifest", () => {
    expect(validatePluginBundle({ pluginId: manifest.id, uiJavaScript: "parent.postMessage({ready:true}, '*')" }, manifest)).toMatchObject({ pluginId: manifest.id });
    expect(() => validatePluginBundle({ pluginId: "com.example.other", uiJavaScript: "ok" }, manifest)).toThrow();
    expect(() => validatePluginBundle({ pluginId: manifest.id, uiJavaScript: "x".repeat(MAX_PLUGIN_BUNDLE_BYTES + 1) }, manifest)).toThrow();
  });

  it("never injects raw JavaScript into the HTML parser", () => {
    const source = 'document.body.innerHTML="</script><img src=x>"';
    const bootstrap = pluginBundleBootstrap(validatePluginBundle({ pluginId: manifest.id, uiJavaScript: source }, manifest));
    expect(bootstrap).toContain("atob(encoded)");
    expect(bootstrap).not.toContain(source);
    expect(bootstrap.match(/<script>/g)).toHaveLength(1);
    expect(bootstrap.match(/<\/script>/g)).toHaveLength(1);
  });
});
