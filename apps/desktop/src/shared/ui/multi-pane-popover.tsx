import { useMemo, useState, type ReactNode } from "react";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/shared/lib/utils";

export interface MultiPaneDefinition<TPane extends string> {
  id: TPane;
  title: string;
  /** Pane the back button returns to; the main pane by default. */
  parent?: TPane;
  content: ReactNode;
  footer?: ReactNode;
  footerSeparator?: boolean;
  notice?: ReactNode;
  /**
   * The content scrolls a part of itself, keeping the rest in place, as a
   * search above its list; otherwise the whole content scrolls.
   */
  scrollsItself?: boolean;
}

interface MultiPanePopoverProps<TPane extends string> {
  trigger?: ReactNode;
  anchor?: ReactNode;
  panes: Array<MultiPaneDefinition<TPane>>;
  mainPane: TPane;
  initialPane?: TPane;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  pane?: TPane;
  onPaneChange?: (pane: TPane) => void;
  align?: "start" | "center" | "end";
  side?: "top" | "right" | "bottom" | "left";
  /** Modal keeps its own scroll lock, so the wheel scrolls it inside a sheet. */
  modal?: boolean;
  className?: string;
}

export function MultiPanePopover<TPane extends string>({
  anchor,
  trigger,
  panes,
  mainPane,
  initialPane,
  open,
  onOpenChange,
  pane,
  onPaneChange,
  align = "end",
  side,
  modal,
  className,
}: MultiPanePopoverProps<TPane>) {
  const [innerPane, setInnerPane] = useState<TPane>(initialPane ?? mainPane);
  const activePane = pane ?? innerPane;
  const paneById = useMemo(
    () => new Map(panes.map((item) => [item.id, item])),
    [panes],
  );
  const current =
    paneById.get(activePane) ?? paneById.get(mainPane) ?? panes[0];

  function handleOpenChange(nextOpen: boolean) {
    if (nextOpen) {
      const next = initialPane ?? mainPane;
      setInnerPane(next);
      if (pane === undefined) onPaneChange?.(next);
    }
    onOpenChange?.(nextOpen);
  }

  function setPane(next: TPane) {
    setInnerPane(next);
    onPaneChange?.(next);
  }

  function handleBack() {
    if (activePane === mainPane) {
      onOpenChange?.(false);
      return;
    }
    setPane(paneById.get(activePane)?.parent ?? mainPane);
  }

  return (
    <Popover open={open} onOpenChange={handleOpenChange} modal={modal}>
      {trigger ? <PopoverTrigger asChild>{trigger}</PopoverTrigger> : null}
      {!trigger && anchor ? (
        <PopoverAnchor asChild>{anchor}</PopoverAnchor>
      ) : null}
      <PopoverContent
        align={align}
        side={side}
        className={cn(
          "flex w-80 max-h-[min(640px,var(--radix-popover-content-available-height))] flex-col gap-0 overflow-hidden !rounded-[10px] !p-0 !shadow-[0_0_0_1px_rgba(0,0,0,0.08),0_12px_32px_-8px_rgba(0,0,0,0.18),0_4px_8px_-2px_rgba(0,0,0,0.08)]",
          className,
        )}
      >
        {activePane === mainPane ? null : (
          <>
            <div className="flex h-10 shrink-0 items-center gap-1 px-2">
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                onClick={handleBack}
              >
                <ArrowLeft data-icon="inline-start" />
                <span className="sr-only">Back</span>
              </Button>
              <div className="min-w-0 truncate text-sm font-medium">
                {current?.title}
              </div>
            </div>
            <Separator />
          </>
        )}
        <div
          className={cn(
            "min-h-0",
            current?.scrollsItself ? "flex flex-col" : "overflow-y-auto",
          )}
        >
          {current?.content}
        </div>
        {current?.notice ? (
          <>
            <Separator />
            <div className="shrink-0 px-3 py-2 text-xs text-muted-foreground">
              {current.notice}
            </div>
          </>
        ) : null}
        {current?.footer ? (
          <>
            {current.footerSeparator === false ? null : <Separator />}
            <div className="shrink-0 p-1">{current.footer}</div>
          </>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
