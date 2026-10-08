import { toast } from "sonner";
import { openInSystem } from "../api/attachments";
import type { AgentSessionKeyDto } from "../api/chat";
import { openMediaData } from "../api/media";
import { attachmentOf } from "../model/attachments";
import type { ChatMedia } from "../model/media";
import { useOpenAttachment } from "./use-attachment-opener";
import * as m from "@/paraglide/messages.js";

/**
 * Opens a media tile by the badge rule (`08` R2): a file of the project in
 * the Attachments Peek, any other file in its system app, media without a
 * file through a temp file in its system app.
 */
export function useOpenMedia(
  session: AgentSessionKeyDto,
): (media: ChatMedia) => void {
  const openAttachment = useOpenAttachment();
  return (media) => {
    if (media.path) {
      if (openAttachment) {
        openAttachment(attachmentOf(media.path, media.name ?? undefined));
      } else {
        void openInSystem(media.path);
      }
      return;
    }
    if (media.data) {
      openMediaData(session, media).catch((error: unknown) => {
        toast.error(
          m.sessions_chat_media_open_failed({
            message: error instanceof Error ? error.message : String(error),
          }),
        );
      });
    }
  };
}
