/**
 * M0's minimum observable UX contract. These names are intentionally product
 * states, not component names, so Runtime, Player, and Export can expose the
 * same semantics without coupling to a particular UI framework.
 */
export const RUNTIME_UX_CONTRACT = {
  mutation: {
    states: ["pending", "committed", "rolled-back"],
    requiredAccessibility: ["status-announcement"],
  },
  resourceTask: {
    states: ["loading", "ready", "cancelled", "failed"],
    requiredActions: ["cancel", "retry"],
    requiredAccessibility: ["status-announcement"],
  },
  staleRevision: {
    states: ["fresh", "stale"],
    requiredActions: ["restart-from-latest", "dismiss"],
    requiredAccessibility: ["focus-visible", "keyboard-operable"],
  },
  permission: {
    states: ["granted", "denied"],
    requiredActions: ["dismiss"],
    requiredAccessibility: ["focus-visible", "keyboard-operable"],
  },
  player: {
    requiredInteractions: ["keyboard-navigation", "escape-close-overlay", "focus-restore"],
    motionModes: ["full", "reduced"],
  },
} as const;

export type RuntimeUxContract = typeof RUNTIME_UX_CONTRACT;

export function validateRuntimeUxContract(contract: RuntimeUxContract = RUNTIME_UX_CONTRACT): void {
  for (const [surface, definition] of Object.entries(contract)) {
    const values = Object.values(definition).flat();
    if (!values.length || values.some((value) => !value.trim())) {
      throw new Error(`Runtime UX contract ${surface} is incomplete.`);
    }
  }
}
