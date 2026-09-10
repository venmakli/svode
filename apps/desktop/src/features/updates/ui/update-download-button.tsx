import { useCallback, type RefObject } from "react";
import { Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import * as m from "@/paraglide/messages.js";
import { useDogfoodUpdates } from "../hooks/use-dogfood-updates";
import "./update-download-button.css";

export function DogfoodUpdateDownloadButton({
  returnFocusRef,
}: {
  returnFocusRef: RefObject<HTMLButtonElement | null>;
}) {
  const updates = useDogfoodUpdates();
  const buttonRef = useCallback(
    (node: HTMLButtonElement | null) => {
      if (!node) return;
      return () => {
        if (
          node.ownerDocument.activeElement === node &&
          returnFocusRef.current?.isConnected
        ) {
          returnFocusRef.current.focus();
        }
      };
    },
    [returnFocusRef],
  );

  if (!updates.update) return null;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          ref={buttonRef}
          size="icon"
          data-update-download
          aria-label={m.updates_download_update()}
          onClick={() => void updates.openUpdate()}
        >
          <Download />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top">{m.updates_download_update()}</TooltipContent>
    </Tooltip>
  );
}
