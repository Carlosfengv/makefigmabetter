"use client";

import { Button } from "@/components/ui/button";

/** A compact polite announcement with an optional reversible action. */
export function Toast({
  message,
  action,
}: {
  message: string;
  action?: { label: string; onClick: () => void };
}) {
  return (
    <div
      className="fixed right-4 bottom-4 z-50 flex items-center gap-3 rounded-lg border bg-background px-3 py-2 text-sm shadow-lg"
      role="status"
      aria-live="polite"
    >
      {message}
      {action && (
        <Button variant="link" size="sm" onClick={action.onClick}>
          {action.label}
        </Button>
      )}
    </div>
  );
}
