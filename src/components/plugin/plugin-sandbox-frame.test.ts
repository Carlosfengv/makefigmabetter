import { describe, expect, it } from "vitest";
import { PLUGIN_SANDBOX_ATTRIBUTE, pluginSandboxSrcDoc } from "./plugin-sandbox-frame";

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
});
