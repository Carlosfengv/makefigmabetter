export const RUNTIME_ERROR_CODES = [
  "RUNTIME_CLOSED",
  "NODE_NOT_FOUND",
  "NODE_REMOVED",
  "PAGE_NOT_LOADED",
  "UNSUPPORTED_NODE_TYPE",
  "UNSUPPORTED_PROPERTY",
  "UNSUPPORTED_FEATURE",
  "INVALID_ARGUMENT",
  "FONT_NOT_LOADED",
  "RESOURCE_UNAVAILABLE",
  "RESOURCE_LIMIT",
  "TASK_CANCELLED",
  "TIMEOUT",
  "URL_NOT_ALLOWED",
  "PERMISSION_DENIED",
  "REVISION_CONFLICT",
  "REVISION_LEASE_EXPIRED",
  "TRANSACTION_ABORTED",
  "EXPORT_FAILED",
  "INTERNAL_ERROR",
] as const;

export type RuntimeErrorCode = (typeof RUNTIME_ERROR_CODES)[number];

export type RuntimeErrorContext = Readonly<{
  nodeId?: string;
  transactionId?: string;
  revision?: number;
}>;

type RuntimeErrorDefinition = Readonly<{
  safeMessage: string;
  retryable: boolean;
}>;

const DEFINITIONS: Record<RuntimeErrorCode, RuntimeErrorDefinition> = {
  RUNTIME_CLOSED: { safeMessage: "The runtime session is closed.", retryable: false },
  NODE_NOT_FOUND: { safeMessage: "The requested node was not found.", retryable: false },
  NODE_REMOVED: { safeMessage: "The requested node has been removed.", retryable: false },
  PAGE_NOT_LOADED: { safeMessage: "Load this page before accessing its contents.", retryable: true },
  UNSUPPORTED_NODE_TYPE: { safeMessage: "This node type is not supported by the runtime.", retryable: false },
  UNSUPPORTED_PROPERTY: { safeMessage: "This property is not supported by the runtime.", retryable: false },
  UNSUPPORTED_FEATURE: { safeMessage: "This feature is not supported by the runtime.", retryable: false },
  INVALID_ARGUMENT: { safeMessage: "One or more arguments are invalid.", retryable: false },
  FONT_NOT_LOADED: { safeMessage: "Load the required font before editing this text.", retryable: true },
  RESOURCE_UNAVAILABLE: { safeMessage: "The required resource is not available.", retryable: true },
  RESOURCE_LIMIT: { safeMessage: "This operation exceeds a runtime resource limit.", retryable: false },
  TASK_CANCELLED: { safeMessage: "The runtime task was cancelled.", retryable: true },
  TIMEOUT: { safeMessage: "The runtime task timed out.", retryable: true },
  URL_NOT_ALLOWED: { safeMessage: "This URL is not allowed by the runtime policy.", retryable: false },
  PERMISSION_DENIED: { safeMessage: "You do not have permission for this operation.", retryable: false },
  REVISION_CONFLICT: { safeMessage: "The document changed before this operation could be applied.", retryable: true },
  REVISION_LEASE_EXPIRED: { safeMessage: "The frozen revision is no longer available.", retryable: true },
  TRANSACTION_ABORTED: { safeMessage: "The transaction was rejected and rolled back.", retryable: false },
  EXPORT_FAILED: { safeMessage: "The export could not be completed.", retryable: true },
  INTERNAL_ERROR: { safeMessage: "The runtime could not complete this operation.", retryable: false },
};

export class RuntimeError extends Error {
  readonly name = "RuntimeError";

  constructor(
    readonly code: RuntimeErrorCode,
    readonly retryable: boolean,
    readonly context: RuntimeErrorContext = {},
    message: string,
  ) {
    super(message);
  }
}

export function runtimeError(code: RuntimeErrorCode, context: RuntimeErrorContext = {}): RuntimeError {
  const definition = DEFINITIONS[code];
  return new RuntimeError(code, definition.retryable, context, definition.safeMessage);
}

export function isRuntimeError(value: unknown, code?: RuntimeErrorCode): value is RuntimeError {
  return value instanceof RuntimeError && (code === undefined || value.code === code);
}
