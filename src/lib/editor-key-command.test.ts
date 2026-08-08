import { describe, expect, it } from "vitest";
import {
  editorKeyCommand,
  isAlternativeUngroupShortcut,
  type EditorKeyInput,
} from "./editor-key-command";

describe("editor keyboard commands", () => {
  const selection = ["first", "second"];
  const keyCommand = (input: Omit<EditorKeyInput, "alternativeUngroup">) =>
    editorKeyCommand({ ...input, alternativeUngroup: false });

  it("maps both platform delete keys to one canonical delete command", () => {
    expect(
      keyCommand({ key: "Backspace", metaKey: false, shiftKey: false, selectedIds: selection }),
    ).toEqual({ type: "delete", ids: selection });
    expect(
      keyCommand({ key: "Delete", metaKey: false, shiftKey: false, selectedIds: selection }),
    ).toEqual({ type: "delete", ids: selection });
  });

  it("keeps undo, redo and duplicate semantics deterministic", () => {
    expect(keyCommand({ key: "z", metaKey: true, shiftKey: false, selectedIds: selection })).toEqual({ type: "undo" });
    expect(keyCommand({ key: "z", metaKey: true, shiftKey: true, selectedIds: selection })).toEqual({ type: "redo" });
    expect(keyCommand({ key: "D", metaKey: true, shiftKey: false, selectedIds: selection })).toEqual({ type: "duplicate", ids: selection });
  });

  it("groups a non-empty selection and ungroups one selected layer", () => {
    expect(keyCommand({ key: "g", metaKey: true, shiftKey: false, selectedIds: selection })).toEqual({ type: "group", ids: selection });
    expect(keyCommand({ key: "G", metaKey: true, shiftKey: true, selectedIds: ["group"], selectedKinds: ["group"] })).toEqual({ type: "ungroup", id: "group" });
    expect(keyCommand({ key: "g", metaKey: true, shiftKey: false, selectedIds: ["only"] })).toEqual({ type: "group", ids: ["only"] });
    expect(keyCommand({ key: "g", metaKey: true, shiftKey: true, selectedIds: selection, selectedKinds: ["rectangle", "ellipse"] })).toBeUndefined();
    expect(keyCommand({ key: "g", metaKey: true, shiftKey: true, selectedIds: ["rectangle"], selectedKinds: ["rectangle"] })).toBeUndefined();
  });

  it("prioritizes alternative Ungroup and never falls back to delete", () => {
    const group = ["group"];
    expect(
      editorKeyCommand({ key: "Delete", metaKey: true, shiftKey: false, alternativeUngroup: true, selectedIds: group, selectedKinds: ["group"] }),
    ).toEqual({ type: "ungroup", id: "group" });
    expect(
      editorKeyCommand({ key: "Backspace", metaKey: true, shiftKey: false, alternativeUngroup: true, selectedIds: group, selectedKinds: ["group"] }),
    ).toEqual({ type: "ungroup", id: "group" });
    expect(
      editorKeyCommand({ key: "Backspace", metaKey: true, shiftKey: false, alternativeUngroup: true, selectedIds: ["rectangle"], selectedKinds: ["rectangle"] }),
    ).toBeUndefined();
    expect(
      editorKeyCommand({ key: "Delete", metaKey: true, shiftKey: false, alternativeUngroup: true, selectedIds: selection, selectedKinds: ["group", "rectangle"] }),
    ).toBeUndefined();
  });

  it("maps alternative Ungroup shortcuts by platform", () => {
    expect(isAlternativeUngroupShortcut({ key: "Delete", metaKey: true, ctrlKey: false, isMac: true })).toBe(true);
    expect(isAlternativeUngroupShortcut({ key: "Backspace", metaKey: true, ctrlKey: false, isMac: true })).toBe(true);
    expect(isAlternativeUngroupShortcut({ key: "Backspace", metaKey: false, ctrlKey: true, isMac: false })).toBe(true);
    expect(isAlternativeUngroupShortcut({ key: "Delete", metaKey: false, ctrlKey: true, isMac: false })).toBe(false);
    expect(isAlternativeUngroupShortcut({ key: "Backspace", metaKey: false, ctrlKey: true, isMac: true })).toBe(false);
  });

  it("maps copy and cut to clipboard commands carrying the current selection", () => {
    expect(keyCommand({ key: "c", metaKey: true, shiftKey: false, selectedIds: selection })).toEqual({ type: "copy", ids: selection });
    expect(keyCommand({ key: "x", metaKey: true, shiftKey: false, selectedIds: selection })).toEqual({ type: "cut", ids: selection });
  });

  it("pastes even with an empty selection because the Worker owns target resolution", () => {
    expect(keyCommand({ key: "v", metaKey: true, shiftKey: false, selectedIds: [] })).toEqual({ type: "paste" });
    expect(keyCommand({ key: "v", metaKey: true, shiftKey: false, selectedIds: selection })).toEqual({ type: "paste" });
  });

  it("does not copy or cut with no selection", () => {
    expect(keyCommand({ key: "c", metaKey: true, shiftKey: false, selectedIds: [] })).toBeUndefined();
    expect(keyCommand({ key: "x", metaKey: true, shiftKey: false, selectedIds: [] })).toBeUndefined();
  });

  it("does not dispatch a destructive command with no selection", () => {
    expect(keyCommand({ key: "Delete", metaKey: false, shiftKey: false, selectedIds: [] })).toBeUndefined();
  });
});
