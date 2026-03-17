import { PanelLeft, PanelRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useSidebar } from "@/components/ui/sidebar";
import { useLayoutStore } from "@/stores/layout";
import { useFullscreen } from "@/hooks/use-fullscreen";
import { cn } from "@/lib/utils";

export function WindowHeader() {
  const { activeDocument, toggleChatPanel } = useLayoutStore();
  const { toggleSidebar } = useSidebar();
  const isFullscreen = useFullscreen();

  const chatToggleDisabled = !activeDocument;

  return (
    <header
      data-tauri-drag-region
      className={cn(
        "fixed top-0 left-0 right-0 z-20 flex h-[44px] items-center justify-between pr-2",
        isFullscreen ? "pl-2" : "pl-[80px]"
      )}
    >
      {/* Left: sidebar toggle */}
      <div className="flex items-center">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={toggleSidebar}
            >
              <PanelLeft className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">Toggle sidebar (⌘\)</TooltipContent>
        </Tooltip>
      </div>

      {/* Right: chat panel toggle */}
      <div className="flex items-center">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={toggleChatPanel}
              disabled={chatToggleDisabled}
            >
              <PanelRight className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">Toggle chat panel (⌘R)</TooltipContent>
        </Tooltip>
      </div>
    </header>
  );
}
