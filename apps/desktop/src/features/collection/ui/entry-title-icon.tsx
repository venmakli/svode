import { FileText } from "lucide-react";
import { cn } from "@/shared/lib/utils";

export function EntryTitleIcon({
  icon,
  className,
  fallbackClassName,
}: {
  icon?: string | null;
  className?: string;
  fallbackClassName?: string;
}) {
  const normalizedIcon = typeof icon === "string" && icon.trim() ? icon : null;

  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center justify-center",
        className,
      )}
      aria-hidden
    >
      {normalizedIcon ? (
        <span className="leading-none">{normalizedIcon}</span>
      ) : (
        <FileText
          className={cn("size-3.5 text-muted-foreground", fallbackClassName)}
        />
      )}
    </span>
  );
}
