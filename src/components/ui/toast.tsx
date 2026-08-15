"use client";

/** A compact polite announcement with an optional reversible action. */
export function Toast({ message, action }: {
  message: string;
  action?: { label: string; onClick: () => void };
}) {
  return <div className="workspace-toast" role="status" aria-live="polite">
    {message}
    {action && <button type="button" onClick={action.onClick}>{action.label}</button>}
  </div>;
}
