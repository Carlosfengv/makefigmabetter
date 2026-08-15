import type { EditorCommand, ToolKind } from "./editor-protocol";

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

/** Returns the world-space movement for a selection nudge. This stays separate
 * from `editorKeyCommand`: resolving a canonical node patch needs the Worker
 * document, especially for Relative-v1 children under rotated parents. */
export function keyboardNudgeDelta(input: Readonly<Pick<EditorKeyInput, "key" | "metaKey" | "shiftKey" | "selectedIds">>) {
  if (input.metaKey || !input.selectedIds.length) return undefined;
  const amount = input.shiftKey ? 10 : 1;
  switch (input.key) {
    case "ArrowLeft": return { x: -amount, y: 0 };
    case "ArrowRight": return { x: amount, y: 0 };
    case "ArrowUp": return { x: 0, y: -amount };
    case "ArrowDown": return { x: 0, y: amount };
    default: return undefined;
  }
}

/** Escape returns the canvas to its neutral selection state. Text fields and
 * canvas text editing keep their own Escape handling before a key reaches the
 * Worker, so this only applies to ordinary editor chrome and the canvas. */
export function shouldClearCanvasSelection(input: Readonly<Pick<EditorKeyInput, "key" | "metaKey" | "shiftKey" | "selectedIds">>): boolean {
  return input.key === "Escape" && !input.metaKey && !input.shiftKey && input.selectedIds.length > 0;
}

/**
 * A tool's Enter action belongs to the editor, even when a toolbar button still
 * has DOM focus. Claiming it prevents the browser from clicking that stale
 * button after the Worker has already received the creation request.
 */
export function shouldClaimKeyboardToolEnter(input: Readonly<{
  key: string;
  modifier: boolean;
  shiftKey: boolean;
  tool: ToolKind;
}>): boolean {
  return input.key === "Enter" && !input.modifier && !input.shiftKey
    && input.tool !== "select" && input.tool !== "hand";
}

/** Resolves the document-mutating keyboard subset owned by the Engine Worker.
 * It deliberately excludes tool and focus navigation, which remain browser UI
 * concerns. Empty selection never creates a destructive command. */
export function editorKeyCommand(input: EditorKeyInput): EditorCommand | undefined {
  const key = input.key.toLowerCase();
  if (input.metaKey && key === "z") return { type: input.shiftKey ? "redo" : "undo" };
  // Windows and Linux conventionally expose Redo as Ctrl+Y. `metaKey` has
  // already been normalized by the browser shell to mean the platform command
  // modifier, so Core remains platform-independent.
  if (input.metaKey && !input.shiftKey && key === "y") return { type: "redo" };
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
