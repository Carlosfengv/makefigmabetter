"use client";

import { useEffect, useRef } from "react";

const itemSelector = "[role='menuitem']:not([disabled]), a[role='menuitem']";

function menuItems(menu: HTMLElement) {
  return [...menu.querySelectorAll<HTMLElement>(itemSelector)]
    .filter((element) => !element.hasAttribute("hidden") && element.getClientRects().length > 0);
}

/** Keyboard-complete contextual menu primitive used for workspace actions. */
export function Menu({ children, className, label, onClose, returnFocus }: {
  children: React.ReactNode;
  className?: string;
  label: string;
  onClose: () => void;
  returnFocus?: HTMLElement | null;
}) {
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const frame = requestAnimationFrame(() => menuItems(menuRef.current ?? document.createElement("div"))[0]?.focus());
    return () => cancelAnimationFrame(frame);
  }, []);

  const moveFocus = (direction: number) => {
    const menu = menuRef.current;
    if (!menu) return;
    const items = menuItems(menu);
    if (!items.length) return;
    const current = Math.max(0, items.indexOf(document.activeElement as HTMLElement));
    items[(current + direction + items.length) % items.length].focus();
  };

  return <div ref={menuRef} className={className} role="menu" aria-label={label} onClick={(event) => event.stopPropagation()} onKeyDown={(event) => {
    if (event.key === "ArrowDown") { event.preventDefault(); moveFocus(1); }
    else if (event.key === "ArrowUp") { event.preventDefault(); moveFocus(-1); }
    else if (event.key === "Home") { event.preventDefault(); menuItems(event.currentTarget)[0]?.focus(); }
    else if (event.key === "End") { event.preventDefault(); menuItems(event.currentTarget).at(-1)?.focus(); }
    else if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      returnFocus?.focus({ preventScroll: true });
    }
  }}>{children}</div>;
}
