import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/shared/lib/utils";
import { X } from "lucide-react";
import type { PropertyOption } from "../model/types";
import { colorStyle, optionColor } from "../lib/utils";

interface PropertyBadgeProps {
  option: PropertyOption;
  onRemove?: () => void;
  invalid?: boolean;
  className?: string;
}

export function PropertyBadge({
  option,
  onRemove,
  invalid,
  className,
}: PropertyBadgeProps) {
  return (
    <Badge
      variant="secondary"
      className={cn(
        "max-w-full gap-1 rounded-md border px-1.5 text-xs font-medium",
        "border-[color-mix(in_oklab,var(--property-color),transparent_68%)]",
        "bg-[var(--property-color-soft)] text-[var(--property-color)]",
        invalid && "border-warning text-warning",
        className,
      )}
      style={colorStyle(optionColor(option))}
    >
      {option.icon ? <span aria-hidden>{option.icon}</span> : null}
      <span className="min-w-0 truncate">{option.name}</span>
      {onRemove ? (
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className="-mr-1 size-4 rounded-sm text-current opacity-55 hover:bg-[color-mix(in_oklab,currentColor,transparent_82%)] hover:opacity-100"
          onClick={(event) => {
            event.stopPropagation();
            onRemove();
          }}
        >
          <X />
          <span className="sr-only">Remove option</span>
        </Button>
      ) : null}
    </Badge>
  );
}
