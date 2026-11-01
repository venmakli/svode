import type { ComponentProps, ReactNode } from "react";

import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { usePeekStackEntry } from "@/shared/hooks/use-peek-stack-entry";
import { cn } from "@/shared/lib/utils";

/**
 * The overlay of every object peek: the right sheet at peek width over a
 * light scrim, on the peek stack. Closing it by Esc, the scrim or ⌘W asks
 * `onRequestClose`, which runs the leave guard of the content.
 */
export function PeekSheet({
  open,
  title,
  onRequestClose,
  className,
  children,
  ...contentProps
}: {
  open: boolean;
  /** The accessible name of the peek, read by screen readers only. */
  title: string;
  onRequestClose(): void;
  className?: string;
  children: ReactNode;
} & Pick<
  ComponentProps<typeof SheetContent>,
  "onCloseAutoFocus" | "onEscapeKeyDown"
> &
  Record<`data-${string}`, string | boolean | undefined>) {
  usePeekStackEntry(open, onRequestClose);
  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (!next) onRequestClose();
      }}
    >
      <SheetContent
        side="right"
        showCloseButton={false}
        aria-describedby={undefined}
        overlayClassName="bg-black/25 backdrop-blur-none supports-backdrop-filter:backdrop-blur-none"
        className={cn(
          "gap-0 p-0 pt-2 pb-6 data-[side=right]:sm:max-w-none",
          className,
        )}
        style={{ width: "min(1120px, max(720px, 66vw), 94vw)" }}
        {...contentProps}
      >
        <SheetTitle className="sr-only">{title}</SheetTitle>
        {children}
      </SheetContent>
    </Sheet>
  );
}
