import type { CanvasNode, DocumentHyperlinkTarget, DocumentTextProperties } from "./editor-protocol";

export type TextHyperlinkNavigation =
  | Readonly<{ type: "URL"; url: string }>
  | Readonly<{ type: "NODE"; nodeId: string; pageId: string }>;

/** Resolves the canonical UTF-8 style run covering one source character.
 * Callers pass a UTF-16 character start because browser pointer/selection APIs
 * use UTF-16 offsets while the document model stores byte ranges. */
export function textHyperlinkAtUtf16Character(
  text: string,
  properties: DocumentTextProperties | undefined,
  characterStart: number,
): DocumentHyperlinkTarget | undefined {
  if (!text || !properties || !Number.isSafeInteger(characterStart)
    || characterStart < 0 || characterStart >= text.length) return undefined;
  // A position inside a surrogate pair is not a legal character boundary.
  const codeUnit = text.charCodeAt(characterStart);
  if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) return undefined;
  const prefix = text.slice(0, characterStart);
  const byteOffset = encoder.encode(prefix).byteLength;
  const run = properties.runs.find((candidate) =>
    candidate.start <= byteOffset && candidate.end > byteOffset);
  return run?.hyperlink ? structuredClone(run.hyperlink) : undefined;
}

/** Converts stored metadata into an executable editor action. Imported URL
 * strings remain lossless in Canonical state, but only ordinary web URLs are
 * activated. NODE links fail closed unless their target still exists. */
export function resolveTextHyperlinkNavigation(
  target: DocumentHyperlinkTarget,
  nodes: readonly CanvasNode[],
  defaultPageId: string,
): TextHyperlinkNavigation | undefined {
  if (target.type === "URL") {
    try {
      const url = new URL(target.value);
      if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
      return { type: "URL", url: url.href };
    } catch {
      return undefined;
    }
  }
  const node = nodes.find((candidate) => candidate.id === target.value);
  if (!node) return undefined;
  return { type: "NODE", nodeId: node.id, pageId: node.pageId ?? defaultPageId };
}

const encoder = new TextEncoder();
