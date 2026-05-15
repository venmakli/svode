import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";

export interface MultiPaneDefinition<TPane extends string> {
  id: TPane;
  title: string;
  content: ReactNode;
  footer?: ReactNode;
  notice?: ReactNode;
}

interface MultiPanePopoverProps<TPane extends string> {
  trigger: ReactNode;
  panes: Array<MultiPaneDefinition<TPane>>;
  mainPane: TPane;
  initialPane?: TPane;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  pane?: TPane;
  onPaneChange?: (pane: TPane) => void;
  align?: "start" | "center" | "end";
  className?: string;
}

export function MultiPanePopover<TPane extends string>({
  trigger,
  panes,
  mainPane,
  initialPane,
  open,
  onOpenChange,
  pane,
  onPaneChange,
  align = "end",
  className,
}: MultiPanePopoverProps<TPane>) {
  const [innerPane, setInnerPane] = useState<TPane>(initialPane ?? mainPane);
  const activePane = pane ?? innerPane;
  const paneById = useMemo(
    () => new Map(panes.map((item) => [item.id, item])),
    [panes],
  );
  const current = paneById.get(activePane) ?? paneById.get(mainPane) ?? panes[0];

  useEffect(() => {
    if (open) {
      const next = initialPane ?? mainPane;
      setInnerPane(next);
      onPaneChange?.(next);
    }
  }, [initialPane, mainPane, onPaneChange, open]);

  function setPane(next: TPane) {
    setInnerPane(next);
    onPaneChange?.(next);
  }

  function handleBack() {
    if (activePane === mainPane) {
      onOpenChange?.(false);
      return;
    }
    setPane(mainPane);
  }

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent
        align={align}
        className={cn("flex w-80 flex-col overflow-hidden p-0", className)}
      >
        <div className="flex h-10 items-center gap-1 px-2">
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            onClick={handleBack}
          >
            <ArrowLeft data-icon="inline-start" />
            <span className="sr-only">Back</span>
          </Button>
          <div className="min-w-0 truncate text-sm font-medium">{current?.title}</div>
        </div>
        <Separator />
        <div className="min-h-52 flex-1 overflow-hidden">{current?.content}</div>
        {current?.notice ? (
          <>
            <Separator />
            <div className="px-3 py-2 text-xs text-muted-foreground">{current.notice}</div>
          </>
        ) : null}
        {current?.footer ? (
          <>
            <Separator />
            <div className="p-2">{current.footer}</div>
          </>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
