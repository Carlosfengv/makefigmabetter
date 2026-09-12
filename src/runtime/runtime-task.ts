import { runtimeError, type RuntimeError } from "./runtime-errors";

export type RuntimeTaskState = "loading" | "ready" | "cancelled" | "failed";
export type RuntimeTaskControl = Readonly<{ signal: AbortSignal; seal: () => void }>;

/** A project extension for cancellable Runtime resource work. Cancellation is
 * cooperative: executors receive an AbortSignal and must check it before their
 * first durable document write. */
export class RuntimeTask<T> {
  private readonly controller = new AbortController();
  private readonly timeoutId?: ReturnType<typeof setTimeout>;
  private currentState: RuntimeTaskState = "loading";
  private cancellable = true;
  readonly promise: Promise<T>;

  constructor(execute: (control: RuntimeTaskControl) => Promise<T>, timeoutMs?: number) {
    if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) throw runtimeError("INVALID_ARGUMENT");
    if (timeoutMs !== undefined) {
      this.timeoutId = globalThis.setTimeout(() => {
        if (this.cancellable) this.abort(runtimeError("TIMEOUT"));
      }, timeoutMs);
    }
    this.promise = execute({ signal: this.controller.signal, seal: () => { this.cancellable = false; } })
      .then((value) => {
        if (this.controller.signal.aborted) throw abortReason(this.controller.signal.reason);
        this.currentState = "ready";
        return value;
      })
      .catch((error) => {
        const reason = this.controller.signal.aborted ? abortReason(this.controller.signal.reason) : error;
        this.currentState = isCancellation(reason) ? "cancelled" : "failed";
        throw reason;
      })
      .finally(() => { if (this.timeoutId !== undefined) clearTimeout(this.timeoutId); });
  }

  get state(): RuntimeTaskState { return this.currentState; }
  get signal(): AbortSignal { return this.controller.signal; }

  cancel(): void {
    if (this.currentState === "loading" && this.cancellable) this.abort(runtimeError("TASK_CANCELLED"));
  }

  private abort(reason: RuntimeError): void {
    if (!this.controller.signal.aborted) this.controller.abort(reason);
  }
}

function abortReason(reason: unknown): RuntimeError {
  return reason instanceof Error && "code" in reason ? reason as RuntimeError : runtimeError("TASK_CANCELLED");
}

function isCancellation(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as RuntimeError).code === "TASK_CANCELLED";
}
