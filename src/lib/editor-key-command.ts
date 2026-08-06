import type { EditorCommand } from "./editor-protocol";

export type EditorKeyInput = Readonly<{ key: string; metaKey: boolean; shiftKey: boolean; selectedIds: readonly string[]; selectedKinds?: readonly (string | undefined)[] }>;

/** Resolves the document-mutating keyboard subset owned by the Engine Worker.
 * It deliberately excludes tool and focus navigation, which remain browser UI
 * concerns. Empty selection never creates a destructive command. */
export function editorKeyCommand(input: EditorKeyInput): EditorCommand | undefined {
  const key = input.key.toLowerCase();
  if (input.metaKey && key === "z") return { type: input.shiftKey ? "redo" : "undo" };
  if (!input.selectedIds.length) return undefined;
  if (input.metaKey && key === "g") {
    return input.shiftKey
      ? input.selectedIds.length === 1 && input.selectedKinds?.[0] === "group" ? { type: "ungroup", id: input.selectedIds[0] } : undefined
      : input.selectedIds.length >= 2 ? { type: "group", ids: [...input.selectedIds] } : undefined;
  }
  if (input.metaKey && key === "d") return { type: "duplicate", ids: [...input.selectedIds] };
  if (input.key === "Backspace" || input.key === "Delete") return { type: "delete", ids: [...input.selectedIds] };
  return undefined;
}
