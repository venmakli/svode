import { useEffect, useState } from "react";
import {
  readAgentActivityDetail,
  type AgentActivityItemDto,
  type AgentDetailOutcomeDto,
  type AgentSessionKeyDto,
} from "../api/chat";

/** Detail follows a streaming item at most this often. */
const REFRESH_MS = 250;

/**
 * The detail of one timeline item, read only while it is shown and again
 * as the item changes. `null` while it loads.
 */
export function useItemDetail(
  session: AgentSessionKeyDto,
  item: AgentActivityItemDto | null,
  enabled: boolean,
): AgentDetailOutcomeDto | null {
  const [detail, setDetail] = useState<{
    id: string;
    outcome: AgentDetailOutcomeDto;
  } | null>(null);
  const id = item?.id ?? null;
  const version = item ? `${item.status}\n${item.summary}\n${item.hasDetail}` : "";
  useEffect(() => {
    if (!enabled || !id) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      readAgentActivityDetail(session, id)
        .then((outcome) => {
          if (!cancelled) setDetail({ id, outcome });
        })
        .catch((error: unknown) => {
          if (!cancelled) {
            setDetail({
              id,
              outcome: {
                outcome: "error",
                message: error instanceof Error ? error.message : String(error),
              },
            });
          }
        });
    }, detail?.id === id ? REFRESH_MS : 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
    // The session object identity is not part of the read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, id, version, session.agent, session.sessionId]);
  return detail && detail.id === id ? detail.outcome : null;
}
