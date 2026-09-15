import type { BlendMode, CanvasNode } from "./editor-protocol";
import { canContainChildren } from "./node-capabilities";

/** Presence-bearing Canonical marker introduced with engine semantics 10.
 * Missing means the historical MakeFigma behavior where a NORMAL container
 * lets descendants composite directly with the parent's backdrop. */
export const NORMAL_BLEND_ISOLATION_EXTENSION = "makefigma.blend.normal-isolation.v1";

const ENABLED_MARKER = [1] as const;

export function isolatesNormalBlend(
  node: Pick<CanvasNode, "blendMode" | "extensions">,
): boolean {
  const marker = node.extensions?.[NORMAL_BLEND_ISOLATION_EXTENSION];
  return (node.blendMode ?? "normal") === "normal"
    && marker?.length === 1
    && marker[0] === ENABLED_MARKER[0];
}

/** Returns a fresh complete extension map so the existing atomic
 * SetNodeExtensions + Appearance transaction preserves unrelated metadata. */
export function extensionsForNodeBlendMode(
  extensions: CanvasNode["extensions"],
  blendMode: BlendMode,
  isolateNormal = true,
): NonNullable<CanvasNode["extensions"]> {
  const next = { ...(extensions ?? {}) };
  if (blendMode === "normal" && isolateNormal) next[NORMAL_BLEND_ISOLATION_EXTENSION] = [...ENABLED_MARKER];
  else delete next[NORMAL_BLEND_ISOLATION_EXTENSION];
  return next;
}

/** Omits the extension-map write when the marker state is already exact. */
export function nodeBlendExtensionPatch(
  extensions: CanvasNode["extensions"],
  blendMode: BlendMode,
  isolateNormal: boolean,
): NonNullable<CanvasNode["extensions"]> | undefined {
  const marker = extensions?.[NORMAL_BLEND_ISOLATION_EXTENSION];
  const hasMarkerKey = Boolean(extensions && Object.hasOwn(extensions, NORMAL_BLEND_ISOLATION_EXTENSION));
  const shouldIsolate = blendMode === "normal" && isolateNormal;
  if (shouldIsolate && marker?.length === 1 && marker[0] === ENABLED_MARKER[0]) return undefined;
  if (!shouldIsolate && !hasMarkerKey) return undefined;
  return extensionsForNodeBlendMode(extensions, blendMode, isolateNormal);
}

/** Legacy NORMAL containers were rendered with pass-through semantics. Expose
 * that behavior honestly at Figma-shaped read boundaries until the user or an
 * import explicitly selects isolated NORMAL. Primitive NORMAL nodes are
 * unaffected because they have no descendant backdrop interaction. */
export function effectiveNodeBlendMode(
  node: Pick<CanvasNode, "kind" | "blendMode" | "extensions">,
): BlendMode {
  const blendMode = node.blendMode ?? "normal";
  return blendMode === "normal" && canContainChildren(node.kind) && !isolatesNormalBlend(node)
    ? "pass-through"
    : blendMode;
}
