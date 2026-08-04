export type DiagnosticCategory = "lifecycle" | "renderer" | "transaction" | "recovery" | "storage";
export type DiagnosticValue = string | number | boolean;

/** Deliberately excludes document values, names, paths, stack traces and credentials. */
export interface DiagnosticEvent {
  sequence: number;
  atMs: number;
  category: DiagnosticCategory;
  code: string;
  documentRevision?: number;
  transactionId?: string;
  details?: Readonly<Record<string, DiagnosticValue>>;
}

export interface DiagnosticSummary {
  total: number;
  recent: readonly DiagnosticEvent[];
}

export function createDiagnosticRecorder(maxEntries = 80, now = () => performance.now()) {
  const capacity = Math.max(1, Math.floor(maxEntries));
  const recent: DiagnosticEvent[] = [];
  let sequence = 0;

  function record(input: Omit<DiagnosticEvent, "sequence" | "atMs">): DiagnosticEvent {
    const event: DiagnosticEvent = {
      sequence: ++sequence,
      atMs: Math.max(0, finiteOrZero(now())),
      category: input.category,
      code: sanitizeCode(input.code),
      ...(validRevision(input.documentRevision) ? { documentRevision: input.documentRevision } : {}),
      ...(input.transactionId ? { transactionId: input.transactionId.slice(0, 64) } : {}),
      ...(input.details ? { details: sanitizeDetails(input.details) } : {}),
    };
    recent.push(event);
    if (recent.length > capacity) recent.splice(0, recent.length - capacity);
    return event;
  }

  return {
    record,
    summary(): DiagnosticSummary { return { total: sequence, recent: recent.map((event) => structuredClone(event)) }; },
  };
}

function validRevision(value: number | undefined): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function finiteOrZero(value: number): number { return Number.isFinite(value) ? value : 0; }
function sanitizeCode(value: string): string { return value.toUpperCase().replace(/[^A-Z0-9_]/g, "_").slice(0, 64) || "UNKNOWN"; }

function sanitizeDetails(details: Readonly<Record<string, DiagnosticValue>>): Readonly<Record<string, DiagnosticValue>> {
  const sanitized: Record<string, DiagnosticValue> = {};
  for (const [key, value] of Object.entries(details).slice(0, 8)) {
    if (!SAFE_DETAIL_KEYS.has(key)) continue;
    if (typeof value === "string") sanitized[key] = value.slice(0, 120);
    else if (typeof value !== "number" || Number.isFinite(value)) sanitized[key] = value;
  }
  return sanitized;
}

const SAFE_DETAIL_KEYS = new Set(["commandCount", "errorCode", "recoveryAttempt", "visibleNodes", "webgl2Available"]);
