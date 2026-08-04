import { Button } from "@base-ui/react/button";
import type { ComponentProps, PropsWithChildren } from "react";

type IconButtonProps = PropsWithChildren<ComponentProps<typeof Button>> & {
  label: string;
  active?: boolean;
};

export function IconButton({ label, active = false, className = "", children, ...props }: IconButtonProps) {
  return <Button aria-label={label} aria-pressed={active} title={label} className={`icon-button ${active ? "is-active" : ""} ${className}`} {...props}>{children}</Button>;
}
