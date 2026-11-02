import { Globe } from "lucide-react";
import { MessageScrollerItem } from "@/components/ui/message-scroller";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/shared/lib/utils";
import { useOpenAttachment } from "../hooks/use-attachment-opener";
import { useWebPreviews } from "../hooks/use-web-previews";
import { attachmentOf } from "../model/attachments";
import type { TurnChanges } from "../model/changed-files";
import * as m from "@/paraglide/messages.js";

/**
 * «Веб-превью» of a finished turn (Stage 11 `06` H1): one compact row per
 * HTML file it wrote, between its media and its changed files, folded or
 * open; a click opens the file by the badge rule. Without a card there is
 * no row.
 */
export function TurnWebPreviews({ changes }: { changes: TurnChanges }) {
  const previews = useWebPreviews(changes);
  const openAttachment = useOpenAttachment();
  if (previews.length === 0) return null;
  return (
    <MessageScrollerItem>
      <ul className="flex flex-col" data-turn-web-previews>
        {previews.map(({ file, removed }) => (
          <li key={file.path}>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  aria-disabled={removed}
                  aria-label={`${file.name}, ${m.sessions_chat_web_preview()}`}
                  data-web-preview={file.path}
                  onClick={() => {
                    if (!removed)
                      openAttachment?.(attachmentOf(file.path, file.name));
                  }}
                  className={cn(
                    "group/preview flex w-full min-w-0 items-center gap-2 rounded-md py-1 text-left text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
                    removed && "cursor-default text-muted-foreground",
                  )}
                >
                  <Globe className="size-4 shrink-0 text-muted-foreground" />
                  <span
                    className={cn(
                      "min-w-0 truncate",
                      removed
                        ? "line-through"
                        : "group-hover/preview:underline",
                    )}
                  >
                    {file.name}
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {m.sessions_chat_web_preview()}
                  </span>
                </button>
              </TooltipTrigger>
              <TooltipContent className="break-all">
                {removed ? m.sessions_chat_changed_file_removed() : file.path}
              </TooltipContent>
            </Tooltip>
          </li>
        ))}
      </ul>
    </MessageScrollerItem>
  );
}
