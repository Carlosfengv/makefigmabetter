import { describe, expect, it } from "vitest";
import {
  FIGMA_PLUGIN_TYPINGS_VERSION,
  RUNTIME_CAPABILITIES,
  runtimeCapabilitiesFor,
  runtimeCapability,
  validateRuntimeCapabilities,
} from "./runtime-capabilities";

describe("M0 runtime capability matrix", () => {
  it("pins the external Figma type contract and has complete, unique entries", () => {
    expect(FIGMA_PLUGIN_TYPINGS_VERSION).toBe("1.134.0");
    expect(() => validateRuntimeCapabilities()).not.toThrow();
    expect(new Set(RUNTIME_CAPABILITIES.map((capability) => capability.id)).size).toBe(RUNTIME_CAPABILITIES.length);
  });

  it("keeps Runtime-specific status separate from existing editor implementation", () => {
    expect(runtimeCapability("node.sync-write")).toMatchObject({ status: "partial" });
    expect(runtimeCapability("document.find-all")).toMatchObject({ status: "supported" });
    expect(runtimeCapability("text.async-font-and-range")).toMatchObject({ errorCode: "FONT_NOT_LOADED" });
    expect(runtimeCapability("image.async-resource")).toMatchObject({ errorCode: "RESOURCE_UNAVAILABLE" });
    expect(runtimeCapability("node.export-async")).toMatchObject({ status: "partial", surface: "export" });
    expect(runtimeCapability("runtime.commit-async")).toMatchObject({ status: "partial" });
    expect(runtimeCapability("plugin.sandbox")).toMatchObject({ status: "partial", surface: "plugin", errorCode: "PERMISSION_DENIED" });
    expect(runtimeCapability("widget.runtime")).toMatchObject({ status: "partial", errorCode: "PERMISSION_DENIED" });
    expect(runtimeCapabilitiesFor("prototype")).toEqual([expect.objectContaining({ id: "prototype.reactions" })]);
  });
});
