import { MessageScrollerItem } from "@/components/ui/message-scroller";
import type { AgentSessionKeyDto } from "../api/chat";
import { useItemDetail } from "../hooks/use-item-detail";
import { usePathBase } from "../hooks/use-path-base";
import { turnGallery } from "../model/media";
import { messageMediaPaths } from "../model/text-media";
import { lastWhere, type TimelineTurn } from "../model/timeline";
import { ChatMediaView } from "./chat-media";
import { detailText } from "./item-detail";
import * as m from "@/paraglide/messages.js";

/**
 * The media a finished turn created, under its answer (Stage 10 `08` R2):
 * the tiles of the timeline without a heading or a frame, at one place
 * whether the turn is folded or open. Media the answer shows as tiles are
 * left out of it; with nothing left there is no row.
 */
export function TurnGallery({
  session,
  turn,
}: {
  session: AgentSessionKeyDto;
  turn: TimelineTurn;
}) {
  const answer = lastWhere(turn.entries, (entry) => entry.kind === "message");
  const item = answer?.kind === "message" ? answer.item : null;
  // The text the answer shows, as the message reads it.
  const detail = useItemDetail(session, item, Boolean(item?.hasDetail));
  const base = usePathBase();
  const text = item?.hasDetail
    ? (detailText(detail) ?? item.summary)
    : (item?.summary ?? "");
  const media = turnGallery(
    turn,
    item ? messageMediaPaths(text, item.media, base) : [],
  );
  if (media.length === 0) return null;
  return (
    <MessageScrollerItem>
      <div role="group" aria-label={m.sessions_chat_turn_gallery()}>
        <ChatMediaView session={session} media={media} />
      </div>
    </MessageScrollerItem>
  );
}
