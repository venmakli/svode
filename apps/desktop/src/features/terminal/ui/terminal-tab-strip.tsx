import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useTerminalStore } from "@/features/terminal/hooks/use-terminal-store";
import type { TerminalTab } from "@/features/terminal/model/types";

interface TerminalTabStripProps {
  tabs: TerminalTab[];
  activeTabId: string | null;
}

export function TerminalTabStrip({ tabs, activeTabId }: TerminalTabStripProps) {
  const setActiveTab = useTerminalStore((state) => state.setActiveTab);
  const closeTab = useTerminalStore((state) => state.closeTab);

  return (
    <div className="flex min-w-0 max-w-[min(60vw,720px)] shrink items-center gap-1 overflow-x-auto px-1">
      {tabs.map((tab) => {
        const active = tab.id === activeTabId;
        return (
          <div
            key={tab.id}
            className={cn(
              "group flex h-7 min-w-28 max-w-56 items-center gap-1 rounded-md border px-2 text-xs",
              active
                ? "border-border bg-background text-foreground"
                : "border-transparent bg-transparent text-muted-foreground hover:bg-accent hover:text-accent-foreground",
            )}
          >
            <button
              type="button"
              className="min-w-0 flex-1 truncate text-left"
              onClick={() => setActiveTab(tab.id)}
            >
              {tab.title}
            </button>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={`Close ${tab.title}`}
              className="opacity-70 group-hover:opacity-100"
              onClick={() => void closeTab(tab.id)}
            >
              <X />
            </Button>
          </div>
        );
      })}
    </div>
  );
}
