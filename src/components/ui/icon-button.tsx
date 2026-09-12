import { type ComponentProps, type PropsWithChildren } from "react";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

type IconButtonProps = PropsWithChildren<ComponentProps<typeof Button>> & {
  label: string;
  active?: boolean;
};

export function IconButton({
  label,
  active = false,
  className = "",
  children,
  variant,
  size,
  ...props
}: IconButtonProps) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            {...props}
            aria-label={label}
            aria-pressed={active}
            className={className}
            variant={active ? "default" : (variant ?? "ghost")}
            size={size ?? "icon"}
          >
            {children}
          </Button>
        }
      />
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
  );
}
