import type { EditorCommand } from "./editor-protocol";

export type EditorKeyInput = Readonly<{
  key: string;
  metaKey: boolean;
  shiftKey: boolean;
  alternativeUngroup: boolean;
  selectedIds: readonly string[];
  selectedKinds?: readonly (string | undefined)[];
}>;

/** Platform adapter for Figma-compatible alternative Ungroup shortcuts.
 * The worker receives the resolved boolean so document command parsing stays
 * independent of browser and operating-system details. */
export function isAlternativeUngroupShortcut(input: Readonly<{
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  isMac: boolean;
}>): boolean {
  if (input.isMac) {
    return input.metaKey && (input.key === "Backspace" || input.key === "Delete");
  }
  return input.ctrlKey && input.key === "Backspace";
}

/** Resolves the document-mutating keyboard subset owned by the Engine Worker.
 * It deliberately excludes tool and focus navigation, which remain browser UI
 * concerns. Empty selection never creates a destructive command. */
export function editorKeyCommand(input: EditorKeyInput): EditorCommand | undefined {
  const key = input.key.toLowerCase();
  if (input.metaKey && key === "z") return { type: input.shiftKey ? "redo" : "undo" };
  // Paste is the one clipboard verb that must work with an empty selection: the
  // Worker owns the clipboard and no-ops when it is empty, so target resolution
  // (selected container vs. page root) happens there, not here.
  if (input.metaKey && key === "v") return { type: "paste" };
  if (!input.selectedIds.length) return undefined;
  if (input.metaKey && key === "g") {
    return input.shiftKey
      ? input.selectedIds.length === 1 && input.selectedKinds?.[0] === "group" ? { type: "ungroup", id: input.selectedIds[0] } : undefined
      : { type: "group", ids: [...input.selectedIds] };
  }
  if (input.alternativeUngroup) {
    return input.selectedIds.length === 1 && input.selectedKinds?.[0] === "group"
      ? { type: "ungroup", id: input.selectedIds[0] }
      : undefined;
  }
  if (input.metaKey && key === "c") return { type: "copy", ids: [...input.selectedIds] };
  if (input.metaKey && key === "x") return { type: "cut", ids: [...input.selectedIds] };
  if (input.metaKey && key === "d") return { type: "duplicate", ids: [...input.selectedIds] };
  if (input.key === "Backspace" || input.key === "Delete") return { type: "delete", ids: [...input.selectedIds] };
  return undefined;
}
