import { describe, expect, it } from "vitest";
import { editorKeyCommand } from "./editor-key-command";

describe("editor keyboard commands", () => {
  const selection = ["first", "second"];

  it("maps both platform delete keys to one canonical delete command", () => {
    expect(editorKeyCommand({ key: "Backspace", metaKey: false, shiftKey: false, selectedIds: selection })).toEqual({ type: "delete", ids: selection });
    expect(editorKeyCommand({ key: "Delete", metaKey: false, shiftKey: false, selectedIds: selection })).toEqual({ type: "delete", ids: selection });
  });

  it("keeps undo, redo and duplicate semantics deterministic", () => {
    expect(editorKeyCommand({ key: "z", metaKey: true, shiftKey: false, selectedIds: selection })).toEqual({ type: "undo" });
    expect(editorKeyCommand({ key: "z", metaKey: true, shiftKey: true, selectedIds: selection })).toEqual({ type: "redo" });
    expect(editorKeyCommand({ key: "D", metaKey: true, shiftKey: false, selectedIds: selection })).toEqual({ type: "duplicate", ids: selection });
  });

  it("groups a multi-selection and ungroups one selected layer", () => {
    expect(editorKeyCommand({ key: "g", metaKey: true, shiftKey: false, selectedIds: selection })).toEqual({ type: "group", ids: selection });
    expect(editorKeyCommand({ key: "G", metaKey: true, shiftKey: true, selectedIds: ["group"], selectedKinds: ["group"] })).toEqual({ type: "ungroup", id: "group" });
    expect(editorKeyCommand({ key: "g", metaKey: true, shiftKey: false, selectedIds: ["only"] })).toBeUndefined();
    expect(editorKeyCommand({ key: "g", metaKey: true, shiftKey: true, selectedIds: selection, selectedKinds: ["rectangle", "ellipse"] })).toBeUndefined();
    expect(editorKeyCommand({ key: "g", metaKey: true, shiftKey: true, selectedIds: ["rectangle"], selectedKinds: ["rectangle"] })).toBeUndefined();
  });

  it("does not dispatch a destructive command with no selection", () => {
    expect(editorKeyCommand({ key: "Delete", metaKey: false, shiftKey: false, selectedIds: [] })).toBeUndefined();
  });
});
