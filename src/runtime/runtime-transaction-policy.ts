export const RUNTIME_TRANSACTION_POLICIES = ["retry-safe", "rebase-required", "non-retryable"] as const;
export type RuntimeTransactionPolicy = (typeof RUNTIME_TRANSACTION_POLICIES)[number];

export type RuntimeCommandKind =
  | "register-asset"
  | "update-node"
  | "text-range-update"
  | "reparent-node"
  | "insert-child"
  | "clone-node"
  | "external-authorized-import";

const POLICY_BY_COMMAND: Record<RuntimeCommandKind, RuntimeTransactionPolicy> = {
  "register-asset": "retry-safe",
  "update-node": "rebase-required",
  "text-range-update": "rebase-required",
  "reparent-node": "rebase-required",
  "insert-child": "rebase-required",
  "clone-node": "rebase-required",
  "external-authorized-import": "non-retryable",
};

export function runtimeTransactionPolicy(command: RuntimeCommandKind): RuntimeTransactionPolicy {
  return POLICY_BY_COMMAND[command];
}

export type RevisionConflictResolution =
  | Readonly<{ type: "retry" }>
  | Readonly<{ type: "rebase" }>
  | Readonly<{ type: "reject" }>;

export function resolveRevisionConflict(command: RuntimeCommandKind): RevisionConflictResolution {
  switch (runtimeTransactionPolicy(command)) {
    case "retry-safe": return { type: "retry" };
    case "rebase-required": return { type: "rebase" };
    case "non-retryable": return { type: "reject" };
  }
}
