import { describe, expect, it } from "vitest";
import { classifyEditorError, editorError } from "./editor-error";

describe("editor error boundary", () => {
  it("maps stable Core failures without returning the raw message", () => {
    expect(classifyEditorError(new Error("ResourceLimit: /private/document-name"))).toEqual(editorError("RESOURCE_LIMIT"));
    expect(classifyEditorError(new Error("RevisionConflict { expected: 4, actual: 3 }"))).toEqual(editorError("REVISION_CONFLICT"));
    expect(classifyEditorError(new Error("INVALID_COLOR: #secret"))).toEqual(editorError("INVALID_COMMAND"));
    expect(classifyEditorError(new Error("MISSING_NODE: internal-id"))).toEqual(editorError("INVALID_COMMAND"));
  });

  it("contains unknown exceptions behind the internal safe message", () => {
    const error = classifyEditorError(new Error("database password: do-not-expose"));
    expect(error).toEqual(editorError("INTERNAL"));
    expect(JSON.stringify(error)).not.toContain("password");
  });
});
