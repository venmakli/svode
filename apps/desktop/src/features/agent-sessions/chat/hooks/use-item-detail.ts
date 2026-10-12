import { useEffect, useRef, useState } from "react";
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
 * after each change of the item: the runtime sends an item anew whenever
 * its detail changes, even when its summary stays. During a stream the
 * reads come at most every `REFRESH_MS`, and one always follows the last
 * change. `null` while it loads.
 */
export function useItemDetail(
  session: AgentSessionKeyDto,
  item: AgentActivityItemDto | null,
  enabled: boolean,
): AgentDetailOutcomeDto | null {
  const [detail, setDetail] = useState<{
    key: string;
    outcome: AgentDetailOutcomeDto;
  } | null>(null);
  const requestRead = useRef<(() => void) | null>(null);
  const id = item?.id ?? null;
  const key = id ? `${session.agent}\n${session.sessionId}\n${id}` : null;
  useEffect(() => {
    if (!enabled || !id || !key) return;
    let cancelled = false;
    let timer: number | null = null;
    let lastRead = -Infinity;
    let sent = 0;
    let shown = 0;
    const show = (request: number, outcome: AgentDetailOutcomeDto) => {
      // A slower earlier read never replaces a later one.
      if (cancelled || request < shown) return;
      shown = request;
      setDetail({ key, outcome });
    };
    const read = () => {
      timer = null;
      lastRead = performance.now();
      const request = ++sent;
      readAgentActivityDetail(session, id).then(
        (outcome) => show(request, outcome),
        (error: unknown) =>
          show(request, {
            outcome: "error",
            message: error instanceof Error ? error.message : String(error),
          }),
      );
    };
    // A change while a read waits is covered by that read, which starts
    // after it; a waiting read is not pushed back by later changes.
    requestRead.current = () => {
      if (timer !== null) return;
      const wait = Math.max(0, lastRead + REFRESH_MS - performance.now());
      timer = window.setTimeout(read, wait);
    };
    requestRead.current();
    return () => {
      cancelled = true;
      requestRead.current = null;
      if (timer !== null) window.clearTimeout(timer);
    };
    // The session object identity is not part of the read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, id, key]);
  useEffect(() => {
    requestRead.current?.();
  }, [item]);
  return detail && detail.key === key ? detail.outcome : null;
}
