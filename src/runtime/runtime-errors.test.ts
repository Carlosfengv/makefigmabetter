import { describe, expect, it } from "vitest";
import { RUNTIME_ERROR_CODES, isRuntimeError, runtimeError } from "./runtime-errors";

describe("runtime errors", () => {
  it("defines a stable public error for every documented M0 code", () => {
    expect(RUNTIME_ERROR_CODES).toContain("REVISION_LEASE_EXPIRED");
    expect(RUNTIME_ERROR_CODES).toContain("TRANSACTION_ABORTED");
    for (const code of RUNTIME_ERROR_CODES) {
      const error = runtimeError(code, { nodeId: "node-1", transactionId: "tx-1", revision: 3 });
      expect(error.name).toBe("RuntimeError");
      expect(error.code).toBe(code);
      expect(error.message).not.toMatch(/token|secret|authorization:/i);
      expect(isRuntimeError(error, code)).toBe(true);
    }
  });
});
