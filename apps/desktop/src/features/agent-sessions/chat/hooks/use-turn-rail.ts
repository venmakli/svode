import { useCallback, useEffect, useRef } from "react";
import {
  useMessageScroller,
  useMessageScrollerVisibility,
} from "@/components/ui/message-scroller";
import {
  activeTurnRailIndex,
  adjacentTurnRailIndex,
  type TurnRailEntry,
} from "../model/turn-rail";

/**
 * Navigation of the turn rail over the timeline scroller (Stage 10 `08`
 * R4): the active entry follows the scroller's current anchor, a move
 * scrolls to the entry's user message — a user action that leaves the end
 * of the timeline — and ⌥↑/⌥↓ (Alt on Windows and Linux) move one entry
 * while focus is in `timeline` outside a text field.
 */
export function useTurnRail(
  entries: readonly TurnRailEntry[],
  timeline: HTMLElement | null,
) {
  const { currentAnchorId } = useMessageScrollerVisibility();
  const { scrollToMessage } = useMessageScroller();
  const active = activeTurnRailIndex(entries, currentAnchorId);

  const navigate = useCallback(
    (index: number) => {
      const entry = entries[index];
      if (!entry) return;
      scrollToMessage(entry.messageId, { align: "start" });
      // Rows coming into view take their measured height: align once more.
      window.requestAnimationFrame(() => {
        scrollToMessage(entry.messageId, { align: "start" });
      });
    },
    [entries, scrollToMessage],
  );

  const step = useRef({ active, count: entries.length, navigate });
  useEffect(() => {
    step.current = { active, count: entries.length, navigate };
  });

  useEffect(() => {
    if (!timeline) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isTurnStepKey(event) || isTextField(event.target)) return;
      const { active, count, navigate } = step.current;
      event.preventDefault();
      const next = adjacentTurnRailIndex(
        count,
        active,
        event.key === "ArrowUp" ? -1 : 1,
      );
      if (next !== null) navigate(next);
    };
    timeline.addEventListener("keydown", onKeyDown);
    return () => timeline.removeEventListener("keydown", onKeyDown);
  }, [timeline]);

  return { active, navigate };
}

function isTurnStepKey(event: KeyboardEvent): boolean {
  return (
    event.altKey &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.shiftKey &&
    (event.key === "ArrowUp" || event.key === "ArrowDown")
  );
}

function isTextField(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    target.closest("input, textarea, select, [contenteditable='true']") !== null
  );
}
