import { Button } from "@base-ui/react/button";
import { useId, useState, type ComponentProps, type PropsWithChildren } from "react";

type IconButtonProps = PropsWithChildren<ComponentProps<typeof Button>> & {
  label: string;
  active?: boolean;
};

export function IconButton({ label, active = false, className = "", children, ...props }: IconButtonProps) {
  const [visible, setVisible] = useState(false);
  const tooltipId = useId();
  return <span className="icon-button-with-tooltip" onPointerEnter={() => setVisible(true)} onPointerLeave={() => setVisible(false)}>
    <Button aria-label={label} aria-pressed={active} aria-describedby={visible ? tooltipId : undefined} className={`icon-button ${active ? "is-active" : ""} ${className}`} onFocus={() => setVisible(true)} onBlur={() => setVisible(false)} {...props}>{children}</Button>
    {visible && <span id={tooltipId} role="tooltip" className="icon-button-tooltip">{label}</span>}
  </span>;
}
