import type { ComponentProps } from "react";
import { cn } from "@/shared/lib/utils";

/**
 * The visual grammar of a scroll rail: thin ticks at the margin of a long
 * content and, on hover, a floating list of what they lead to with the
 * current item highlighted. Behavior stays with each rail.
 */
export function ScrollRailTicks({
  className,
  ...props
}: ComponentProps<"div">) {
  return (
    <div className={cn("flex flex-col items-end pr-1", className)} {...props} />
  );
}

export function ScrollRailTick({
  active = false,
  className,
  ...props
}: ComponentProps<"button"> & { active?: boolean }) {
  return (
    <button
      type="button"
      data-active={active}
      className={cn(
        // A 2px bar in a 6px row: the rows touch, so any point hits a tick.
        "h-1.5 cursor-pointer rounded-full bg-clip-content py-0.5 transition-colors",
        active ? "bg-foreground" : "bg-muted-foreground/30",
        className,
      )}
      {...props}
    />
  );
}

export function ScrollRailPanel({
  className,
  ...props
}: ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "rounded-md border bg-background/95 px-3 py-2 shadow-md backdrop-blur-sm",
        className,
      )}
      {...props}
    />
  );
}

export function ScrollRailItem({
  active = false,
  className,
  ...props
}: ComponentProps<"button"> & { active?: boolean }) {
  return (
    <button
      type="button"
      className={cn(
        "cursor-pointer py-0.5 text-left text-xs transition-colors hover:text-foreground",
        active ? "font-medium text-primary" : "text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}
