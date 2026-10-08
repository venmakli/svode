import { useEffect, useState } from "react";
import type { AgentSessionSnapshotDto } from "../api/chat";
import { liveTurnActivity, liveTurnCaption } from "../model/live-turn";

export interface LiveEdgeMarker {
  turnId: string;
  caption: string;
}

/**
 * The marker of the running turn at the live edge of the timeline. It
 * comes with the turn's first item and leaves a frame after the turn ends,
 * so it never changes the number of timeline rows together with the
 * turn's own rows: the scroller reads an unchanged number of rows as a
 * replaced message and jumps to it.
 */
export function useLiveEdgeMarker(
  snapshot: Pick<AgentSessionSnapshotDto, "items" | "turn" | "pending">,
): LiveEdgeMarker | null {
  const activity = liveTurnActivity(snapshot);
  const turnId = snapshot.turn.turnId;
  const started =
    activity !== null &&
    turnId !== null &&
    snapshot.items.some((item) => item.turnId === turnId);
  const caption = activity ? liveTurnCaption(activity) : null;

  const [held, setHeld] = useState<LiveEdgeMarker | null>(null);
  if (
    started &&
    caption !== null &&
    (held?.turnId !== turnId || held.caption !== caption)
  ) {
    setHeld({ turnId, caption });
  }
  useEffect(() => {
    if (started || !held) return;
    // A frame later: after the scroller saw the turn's rows change.
    const frame = window.requestAnimationFrame(() => setHeld(null));
    return () => window.cancelAnimationFrame(frame);
  }, [held, started]);

  if (started && caption !== null) return { turnId, caption };
  return held;
}
