import type {} from "@figma/plugin-typings";
import { FIGMA_PLUGIN_TYPINGS_VERSION } from "./runtime-capabilities";

/**
 * Compile-only probes for the exact Plugin API surface M0 uses as its external
 * contract. This function is intentionally never invoked by the application.
 */
export function assertFigmaPluginTypingsContract(node: SceneNode, rectangle: RectangleNode): {
  version: typeof FIGMA_PLUGIN_TYPINGS_VERSION;
  allPages: Promise<void>;
  nodeLookup: Promise<BaseNode | null>;
  svg: Promise<string>;
  reactions: readonly Reaction[];
} {
  node.x = node.x;
  node.y = node.y;
  node.name = node.name;
  rectangle.opacity = rectangle.opacity;

  const action: Action = { type: "URL", url: "https://example.com", openInNewTab: true };
  const reactions: readonly Reaction[] = [{ trigger: { type: "ON_CLICK" }, actions: [action] }];
  const allPages: Promise<void> = figma.loadAllPagesAsync();
  const nodeLookup: Promise<BaseNode | null> = figma.getNodeByIdAsync("0:0");
  const svg: Promise<string> = node.exportAsync({ format: "SVG_STRING" });

  return { version: FIGMA_PLUGIN_TYPINGS_VERSION, allPages, nodeLookup, svg, reactions };
}
