import type { ReactNode } from "react";
import { ChevronRight, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function SettingsSection({ label }: { label: string }) {
  return (
    <div className="px-2.5 pb-1 pt-2 text-[10.5px] font-semibold uppercase tracking-[0.04em] text-muted-foreground">
      {label}
    </div>
  );
}

export function SettingsRow({
  icon: Icon,
  label,
  meta,
  right,
  onClick,
  disabled,
  destructive,
}: {
  icon: LucideIcon;
  label: string;
  meta?: string;
  right?: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  destructive?: boolean;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="default"
      className={cn(
        "min-h-8 w-full justify-start gap-2.5 rounded-md px-2 py-1.5 text-[13px] font-normal",
        "[&_svg:not([class*='size-'])]:size-3.5",
        destructive &&
          "text-destructive hover:bg-destructive/10 hover:text-destructive focus-visible:bg-destructive/10 focus-visible:text-destructive",
      )}
      onClick={onClick}
      disabled={disabled}
    >
      <Icon
        className={cn("text-muted-foreground", destructive && "text-current")}
        data-icon="inline-start"
      />
      <span className="min-w-0 flex-1 truncate text-left font-medium">
        {label}
      </span>
      {meta ? (
        <span className="shrink-0 text-[11.5px] text-muted-foreground">
          {meta}
        </span>
      ) : null}
      {right !== undefined ? (
        right
      ) : onClick ? (
        <ChevronRight
          className={cn(
            "text-muted-foreground",
            destructive && "text-destructive",
          )}
          data-icon="inline-end"
        />
      ) : null}
    </Button>
  );
}
