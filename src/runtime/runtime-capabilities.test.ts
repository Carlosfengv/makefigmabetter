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
    expect(runtimeCapability("node.create-runtime")).toMatchObject({
      status: "partial",
      property: expect.stringContaining("createComponent"),
      nodeTypes: expect.arrayContaining(["COMPONENT", "INSTANCE", "SLOT", "SLICE"]),
    });
    expect(runtimeCapability("node.create-runtime")?.property).toContain("ComponentNode.createInstance");
    expect(runtimeCapability("node.create-runtime")?.property).toContain("ComponentNode.createSlot");
    expect(runtimeCapability("node.create-runtime")?.property).toContain("createComponentFromNode");
    expect(runtimeCapability("node.create-runtime")?.property).toContain("combineAsVariants");
    expect(runtimeCapability("node.sync-write")).toMatchObject({ status: "partial" });
    expect(runtimeCapability("node.clone-runtime")).toMatchObject({
      status: "partial",
      property: "clone",
      nodeTypes: expect.arrayContaining(["FRAME", "COMPONENT", "SLOT", "EMBED", "MEDIA"]),
    });
    expect(runtimeCapability("component.instance-properties-runtime")).toMatchObject({
      status: "partial",
      property: expect.stringContaining("setProperties"),
      nodeTypes: ["COMPONENT", "COMPONENT_SET", "INSTANCE"],
    });
    expect(runtimeCapability("component.instance-properties-runtime")?.property).toContain("addComponentProperty");
    expect(runtimeCapability("component.instance-properties-runtime")?.property).toContain("detachInstance");
    expect(runtimeCapability("component.instance-properties-runtime")?.property).toContain("ComponentSetNode.componentPropertyDefinitions");
    expect(runtimeCapability("component.instance-properties-runtime")?.property).toContain("componentPropertyReferences");
    expect(runtimeCapability("node.sync-write")?.property).not.toMatch(/fills|strokes/);
    expect(runtimeCapability("paint-stack.runtime")).toMatchObject({ property: "fills" });
    expect(runtimeCapability("paint-stack.runtime")?.nodeTypes).toContain("TEXT");
    expect(runtimeCapability("paint-stack.runtime")?.nodeTypes).not.toContain("LINE");
    expect(runtimeCapability("paint-stack.runtime-strokes")).toMatchObject({ property: "strokes" });
    expect(runtimeCapability("paint-stack.runtime-strokes")?.nodeTypes).toContain("LINE");
    expect(runtimeCapability("paint-stack.runtime-strokes")?.nodeTypes).not.toContain("TEXT");
    expect(runtimeCapability("geometry.parametric-runtime")).toMatchObject({
      status: "partial",
      nodeTypes: ["RECTANGLE", "ELLIPSE", "POLYGON", "STAR", "VECTOR", "LINE", "BOOLEAN_OPERATION"],
    });
    expect(runtimeCapability("layout.auto-layout-runtime")).toMatchObject({
      status: "partial",
      property: expect.stringContaining("layoutSizingHorizontal"),
    });
    expect(runtimeCapability("layout.auto-layout-runtime")?.property).toContain("counterAxisAlignContent");
    expect(runtimeCapability("layout.auto-layout-runtime")?.property).toContain("layoutAlign");
    expect(runtimeCapability("special-nodes.runtime-subset")).toMatchObject({
      status: "partial",
      nodeTypes: ["CONNECTOR", "SHAPE_WITH_TEXT", "TEXT_PATH", "TRANSFORM_GROUP"],
      property: expect.stringContaining("createTextPath"),
    });
    expect(runtimeCapability("document.find-all")).toMatchObject({ status: "supported" });
    expect(runtimeCapability("text.async-font-and-range")).toMatchObject({ errorCode: "FONT_NOT_LOADED" });
    expect(runtimeCapability("text.async-font-and-range")?.property).toContain("textAutoResize");
    expect(runtimeCapability("image.async-resource")).toMatchObject({ errorCode: "RESOURCE_UNAVAILABLE" });
    expect(runtimeCapability("image.async-resource")?.property).toContain("createGif");
    expect(runtimeCapability("image.async-resource")?.property).toContain("mediaData");
    expect(runtimeCapability("image.async-resource")?.nodeTypes).toContain("MEDIA");
    expect(runtimeCapability("special-preview.runtime")).toMatchObject({
      nodeTypes: ["EMBED", "LINK_UNFURL"],
      property: "embedData|linkUnfurlData|createLinkPreviewAsync",
      surface: "write",
    });
    expect(runtimeCapability("node.export-async")).toMatchObject({ status: "partial", surface: "export" });
    expect(runtimeCapability("runtime.commit-async")).toMatchObject({ status: "partial" });
    expect(runtimeCapability("plugin.sandbox")).toMatchObject({ status: "partial", surface: "plugin", errorCode: "PERMISSION_DENIED" });
    expect(runtimeCapability("widget.runtime")).toMatchObject({ status: "partial", errorCode: "PERMISSION_DENIED" });
    expect(runtimeCapabilitiesFor("prototype")).toEqual([expect.objectContaining({ id: "prototype.reactions" })]);
  });
});
