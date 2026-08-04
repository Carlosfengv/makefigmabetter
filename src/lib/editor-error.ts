export type EditorErrorCode = "INVALID_COMMAND" | "REVISION_CONFLICT" | "AUTHZ_DENIED" | "RESOURCE_LIMIT" | "UNSUPPORTED_FEATURE" | "CORRUPT_DATA" | "TRANSIENT" | "INTERNAL";

export interface EditorError {
  code: EditorErrorCode;
  safeMessage: string;
  retryable: boolean;
}

const errors: Record<EditorErrorCode, Omit<EditorError, "code">> = {
  INVALID_COMMAND: { safeMessage: "The requested edit is invalid.", retryable: false },
  REVISION_CONFLICT: { safeMessage: "This document changed. Refresh the selection and try again.", retryable: true },
  AUTHZ_DENIED: { safeMessage: "You do not have permission for this edit.", retryable: false },
  RESOURCE_LIMIT: { safeMessage: "This edit exceeds the configured resource limit.", retryable: false },
  UNSUPPORTED_FEATURE: { safeMessage: "This feature is not supported in the current engine.", retryable: false },
  CORRUPT_DATA: { safeMessage: "The document data could not be read safely.", retryable: false },
  TRANSIENT: { safeMessage: "The engine is temporarily unavailable. Please try again.", retryable: true },
  INTERNAL: { safeMessage: "The engine could not complete this request.", retryable: false },
};

export function editorError(code: EditorErrorCode): EditorError {
  return { code, ...errors[code] };
}

/** Maps only stable engine classifications; raw exception text never crosses the Worker boundary. */
export function classifyEditorError(error: unknown): EditorError {
  const message = error instanceof Error ? error.message : "";
  if (/RevisionConflict|REVISION_CONFLICT/i.test(message)) return editorError("REVISION_CONFLICT");
  if (/ResourceLimit|RESOURCE_LIMIT/i.test(message)) return editorError("RESOURCE_LIMIT");
  if (/Authorization|AUTHZ|WriteDenied/i.test(message)) return editorError("AUTHZ_DENIED");
  if (/Unsupported|UNSUPPORTED/i.test(message)) return editorError("UNSUPPORTED_FEATURE");
  if (/Corrupt|CORRUPT_DATA|INVALID_CORE_SNAPSHOT/i.test(message)) return editorError("CORRUPT_DATA");
  if (/MissingNode|MISSING_|Invalid|INVALID_|DuplicateNode|RetiredNodeId|NodeHasChildren/i.test(message)) return editorError("INVALID_COMMAND");
  if (/Network|Timeout|TRANSIENT/i.test(message)) return editorError("TRANSIENT");
  return editorError("INTERNAL");
}
