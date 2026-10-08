import { memo, useState } from "react";
import { Marker, MarkerContent, MarkerIcon } from "@/components/ui/marker";
import { ProjectLoadingLogo } from "@/features/branding";
import type { AgentSessionKeyDto } from "../api/chat";
import { useTurnElapsed } from "../hooks/use-turn-elapsed";
import { formatDuration } from "../model/format";
import * as m from "@/paraglide/messages.js";

/**
 * The last row of a running turn (`08`, R6): the animated logo, what the
 * agent does now and how long the turn runs. The status announces the start
 * of the turn; the caption and the time change without being announced.
 */
export const LiveTurnMarker = memo(function LiveTurnMarker({
  session,
  turnId,
  caption,
}: {
  session: AgentSessionKeyDto;
  turnId: string;
  caption: string;
}) {
  const elapsed = useTurnElapsed(session, turnId);
  return (
    <Marker role="status">
      <span className="sr-only">{m.sessions_chat_live_started()}</span>
      <MarkerIcon className="flex items-center justify-center">
        <ProjectLoadingLogo size={1} />
      </MarkerIcon>
      <span aria-live="off" className="flex min-w-0 items-baseline gap-2">
        <MarkerContent
          data-live-turn-caption=""
          className="shimmer truncate text-muted-foreground/70"
        >
          {caption}
        </MarkerContent>
        <span className="shrink-0 text-xs text-muted-foreground/70 tabular-nums">
          {formatDuration(elapsed)}
        </span>
      </span>
    </Marker>
  );
});

/**
 * Announces the end of a turn this timeline saw running; it stays mounted
 * with the timeline so the change of its text is heard.
 */
export function LiveTurnEnd({ live }: { live: boolean }) {
  const [sawLive, setSawLive] = useState(live);
  if (live && !sawLive) setSawLive(true);
  return (
    <div role="status" className="sr-only">
      {sawLive && !live ? m.sessions_chat_live_ended() : ""}
    </div>
  );
}
