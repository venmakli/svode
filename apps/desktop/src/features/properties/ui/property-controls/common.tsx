import { useCallback, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { colorStyle, optionColor } from "../../lib/utils";
import type { PropertyOption } from "../../model/types";

export function deferStateUpdate(update: () => void) {
  let cancelled = false;
  queueMicrotask(() => {
    if (!cancelled) update();
  });
  return () => {
    cancelled = true;
  };
}

export function OptionDot({ option }: { option: PropertyOption }) {
  return (
    <span
      className="size-2 shrink-0 rounded-full bg-(--property-color)"
      style={colorStyle(optionColor(option))}
    />
  );
}

export function useAutoOpen(
  autoOpen: boolean | undefined,
  onOpenChange: ((open: boolean) => void) | undefined,
) {
  const [open, setOpen] = useState(Boolean(autoOpen));

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      setOpen(nextOpen);
      onOpenChange?.(nextOpen);
    },
    [onOpenChange],
  );

  return [open, handleOpenChange] as const;
}

export function IconAction({
  label,
  children,
  className,
  disabled,
  onClick,
}: {
  label: string;
  children: ReactNode;
  className?: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className={className}
            disabled={disabled}
            onMouseDown={(event) => event.preventDefault()}
            onClick={(event) => {
              event.preventDefault();
              onClick();
            }}
          >
            {children}
            <span className="sr-only">{label}</span>
          </Button>
        </TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
