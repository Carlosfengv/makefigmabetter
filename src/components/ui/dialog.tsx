"use client";

import { useEffect, useId, useRef } from "react";

const focusableSelector = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

function focusableChildren(container: HTMLElement) {
  return [...container.querySelectorAll<HTMLElement>(focusableSelector)]
    .filter((element) => !element.hasAttribute("hidden") && element.getClientRects().length > 0);
}

/** A small, dependency-free modal primitive with a real focus boundary. */
export function Dialog({ title, children, onClose, returnFocus }: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
  returnFocus?: HTMLElement | null;
}) {
  const dialogRef = useRef<HTMLElement>(null);
  const closeRef = useRef(onClose);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const titleId = useId();

  useEffect(() => { closeRef.current = onClose; }, [onClose]);

  useEffect(() => {
    returnFocusRef.current = returnFocus ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    const dialog = dialogRef.current;
    if (!dialog) return;

    const focusInitialTarget = () => {
      const preferred = dialog.querySelector<HTMLElement>("[data-dialog-initial-focus], [autofocus]");
      (preferred ?? focusableChildren(dialog)[0] ?? dialog).focus();
    };
    const frame = requestAnimationFrame(focusInitialTarget);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const targets = focusableChildren(dialog);
      if (!targets.length) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = targets[0];
      const last = targets[targets.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("keydown", onKeyDown, true);
      returnFocusRef.current?.focus({ preventScroll: true });
    };
  }, [returnFocus]);

  return <div className="workspace-dialog-backdrop" role="presentation" onMouseDown={() => closeRef.current()}>
    <section ref={dialogRef} className="workspace-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} onMouseDown={(event) => event.stopPropagation()}>
      <header><h2 id={titleId}>{title}</h2><button type="button" onClick={() => closeRef.current()} aria-label="关闭">×</button></header>
      {children}
    </section>
  </div>;
}
