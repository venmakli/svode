import type { ReactNode } from "react";
import { ChevronRight, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function SettingsSection({ label }: { label: string }) {
  return (
    <div className="px-2 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
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
        "h-9 w-full justify-start px-2 text-sm font-normal",
        destructive &&
          "text-destructive hover:bg-destructive/10 hover:text-destructive focus-visible:bg-destructive/10 focus-visible:text-destructive",
      )}
      onClick={onClick}
      disabled={disabled}
    >
      <Icon data-icon="inline-start" />
      <span className="min-w-0 flex-1 truncate text-left">{label}</span>
      {meta ? (
        <span className="text-xs text-muted-foreground">{meta}</span>
      ) : null}
      {right !== undefined ? (
        right
      ) : onClick ? (
        <ChevronRight
          className={cn(destructive && "text-destructive")}
          data-icon="inline-end"
        />
      ) : null}
    </Button>
  );
}
