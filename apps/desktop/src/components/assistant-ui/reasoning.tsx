import { memo, useCallback, useRef, useState } from "react";
import { ChevronDownIcon } from "lucide-react";
import { useScrollLock } from "@assistant-ui/react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { MarkdownText } from "./markdown-text";

const ANIMATION_DURATION = 200;

interface ReasoningProps {
  reasoning: string;
  isStreaming?: boolean;
}

const ReasoningImpl = ({ reasoning, isStreaming = false }: ReasoningProps) => {
  const collapsibleRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(isStreaming);
  const lockScroll = useScrollLock(collapsibleRef, ANIMATION_DURATION);

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (!nextOpen) lockScroll();
      setOpen(nextOpen);
    },
    [lockScroll],
  );

  return (
    <Collapsible
      ref={collapsibleRef}
      open={open}
      onOpenChange={handleOpenChange}
      className="aui-reasoning-root my-2 w-full rounded-lg border border-border/50 bg-muted/30"
      style={{ "--animation-duration": `${ANIMATION_DURATION}ms` } as React.CSSProperties}
    >
      <CollapsibleTrigger className="group/trigger flex w-full items-center gap-2 px-3 py-2 text-xs text-muted-foreground transition-colors hover:text-foreground">
        <ChevronDownIcon
          className={cn(
            "size-3.5 shrink-0 transition-transform duration-200 ease-out",
            "group-data-[state=closed]/trigger:-rotate-90",
            "group-data-[state=open]/trigger:rotate-0",
          )}
        />
        <span className="relative inline-block grow text-left leading-none">
          <span>Thinking</span>
          {isStreaming && (
            <span
              aria-hidden
              className="shimmer pointer-events-none absolute inset-0 motion-reduce:animate-none"
            >
              Thinking
            </span>
          )}
        </span>
      </CollapsibleTrigger>

      <CollapsibleContent
        className={cn(
          "relative overflow-hidden text-sm outline-none ease-out",
          "data-[state=closed]:animate-collapsible-up",
          "data-[state=open]:animate-collapsible-down",
          "data-[state=closed]:fill-mode-forwards",
          "data-[state=closed]:pointer-events-none",
          "data-[state=open]:duration-(--animation-duration)",
          "data-[state=closed]:duration-(--animation-duration)",
        )}
      >
        <div className="border-t border-border/30 px-3 py-2 text-xs text-muted-foreground/80 leading-relaxed">
          <div className="whitespace-pre-wrap">{reasoning}</div>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
};

export const Reasoning = memo(ReasoningImpl);
