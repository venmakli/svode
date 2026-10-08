import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { FilePen, ImageIcon } from "lucide-react";
import { cn } from "@/shared/lib/utils";
import {
  ScrollRailItem,
  ScrollRailPanel,
  ScrollRailTick,
  ScrollRailTicks,
} from "@/shared/ui/scroll-rail";
import { useTurnRail } from "../hooks/use-turn-rail";
import type { TimelineTurn } from "../model/timeline";
import {
  turnRailEntries,
  turnRailTicks,
  type TurnRailEntry,
} from "../model/turn-rail";
import * as m from "@/paraglide/messages.js";

/**
 * The turn rail of the timeline (Stage 10 `08` R4) in the grammar of the
 * page outline: ticks at the right margin, outside the text column and the
 * scrolled content, and on hover or focus the list of all turns. Absent
 * below two turns and where the margin cannot hold it; the keys work
 * whenever the timeline has turns.
 */
export function TurnRail({
  turns,
  hiddenTurns,
}: {
  turns: readonly TimelineTurn[];
  /** Earlier turns the retained history no longer holds. */
  hiddenTurns: number | null;
}) {
  const entries = useMemo(() => turnRailEntries(turns), [turns]);
  const [timeline, setTimeline] = useState<HTMLElement | null>(null);
  const placeRef = useCallback((node: HTMLElement | null) => {
    setTimeline(
      node?.closest<HTMLElement>("[data-slot='message-scroller']") ?? null,
    );
  }, []);
  const { active, navigate } = useTurnRail(entries, timeline);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const open = hovered || focused;
  const panelRef = useRef<HTMLDivElement>(null);

  // The list opens at the active turn.
  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!open || !panel) return;
    const row = panel.querySelector<HTMLElement>("[aria-current='location']");
    if (!row) return;
    panel.scrollTop =
      row.offsetTop - (panel.clientHeight - row.offsetHeight) / 2;
    // Only on opening: scrolling the timeline does not move the list.
  }, [open]);

  const ticks = turnRailTicks(entries.length, active);
  const shown = entries.length >= 2;

  const onListKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const rows = Array.from(
      event.currentTarget.querySelectorAll<HTMLElement>("[data-turn-row]"),
    );
    const current = rows.indexOf(document.activeElement as HTMLElement);
    let next: number;
    switch (event.key) {
      case "ArrowUp":
        next = Math.max(current - 1, 0);
        break;
      case "ArrowDown":
        next = Math.min(current + 1, rows.length - 1);
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = rows.length - 1;
        break;
      case "Escape":
        event.preventDefault();
        setFocused(false);
        timeline
          ?.querySelector<HTMLElement>(
            "[data-slot='message-scroller-viewport']",
          )
          ?.focus();
        return;
      default:
        return;
    }
    event.preventDefault();
    rows[next]?.focus();
  };

  return (
    <div
      ref={placeRef}
      data-turn-rail=""
      className="pointer-events-none absolute inset-y-4 end-3 z-10 hidden items-center @min-[54rem]:flex"
    >
      {shown && (
        <nav
          aria-label={m.sessions_chat_turns()}
          onMouseEnter={() => setHovered(true)}
          onMouseLeave={() => setHovered(false)}
          onFocus={() => setFocused(true)}
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node)) {
              setFocused(false);
            }
          }}
        >
          <ScrollRailTicks
            aria-hidden
            className="pointer-events-auto h-40 justify-center"
          >
            {ticks.map((index) => (
              <ScrollRailTick
                key={entries[index].messageId}
                tabIndex={-1}
                active={index === active}
                data-state={entries[index].state}
                className={tickClass(entries[index], index === active)}
                onClick={() => navigate(index)}
              />
            ))}
          </ScrollRailTicks>
          {/* Beside the ticks, which stay clickable; the padding bridges the gap for the pointer. */}
          <div
            data-turn-list={open ? "open" : "closed"}
            className={cn(
              "absolute end-full top-1/2 flex max-h-full -translate-y-1/2 pe-1 transition-opacity",
              open ? "pointer-events-auto" : "pointer-events-none opacity-0",
            )}
          >
            <ScrollRailPanel
              ref={panelRef}
              onKeyDown={onListKeyDown}
              className="relative min-h-0 w-72 overflow-y-auto px-1.5 py-1.5"
            >
              <ul className="flex flex-col gap-0.5">
                {hiddenTurns !== null && hiddenTurns > 0 && (
                  <li className="px-1.5 py-1 text-xs text-muted-foreground">
                    {m.sessions_chat_turns_hidden({ count: hiddenTurns })}
                  </li>
                )}
                {entries.map((entry, index) => (
                  <li key={entry.messageId}>
                    <TurnRow
                      entry={entry}
                      active={index === active}
                      onSelect={() => navigate(index)}
                    />
                  </li>
                ))}
              </ul>
            </ScrollRailPanel>
          </div>
        </nav>
      )}
    </div>
  );
}

function tickClass(entry: TurnRailEntry, active: boolean): string {
  return cn(
    active ? "w-6" : "w-4",
    entry.state === "failed" &&
      (active ? "bg-destructive" : "bg-destructive/60"),
    entry.state === "live" &&
      cn("animate-pulse", active ? "bg-primary" : "bg-primary/60"),
  );
}

function TurnRow({
  entry,
  active,
  onSelect,
}: {
  entry: TurnRailEntry;
  active: boolean;
  onSelect: () => void;
}) {
  const state = stateText(entry);
  const second = state ?? entry.reply;
  return (
    <ScrollRailItem
      data-turn-row=""
      active={active}
      aria-current={active ? "location" : undefined}
      tabIndex={active ? 0 : -1}
      onClick={onSelect}
      className={cn(
        "flex w-full items-start gap-2 rounded-sm px-1.5 py-1 outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
        active && "bg-muted/60",
      )}
    >
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate">
          {entry.title || m.sessions_chat_turn()}
        </span>
        {second && (
          <span
            className={cn(
              "truncate font-normal",
              entry.state === "failed"
                ? "text-destructive"
                : "text-muted-foreground/80",
            )}
          >
            {second}
          </span>
        )}
      </span>
      {entry.createdMedia > 0 && (
        <TurnBadge
          icon={<ImageIcon />}
          count={entry.createdMedia}
          label={m.sessions_chat_turn_created_media({
            count: entry.createdMedia,
          })}
        />
      )}
      {entry.changedFiles > 0 && (
        <TurnBadge
          icon={<FilePen />}
          count={entry.changedFiles}
          label={m.sessions_chat_changed_files({ count: entry.changedFiles })}
        />
      )}
    </ScrollRailItem>
  );
}

/** The state a turn shows in place of its reply, if any. */
function stateText(entry: TurnRailEntry): string | null {
  switch (entry.state) {
    case "live":
      return m.sessions_chat_turn_running();
    case "stopped":
      return m.sessions_chat_turn_stopped();
    case "failed":
      return m.sessions_chat_turn_failed();
    case "done":
      return null;
  }
}

function TurnBadge({
  icon,
  count,
  label,
}: {
  icon: ReactNode;
  count: number;
  label: string;
}) {
  return (
    <span
      title={label}
      className="flex shrink-0 items-center gap-0.5 pt-px font-normal text-muted-foreground [&_svg]:size-3"
    >
      {icon}
      <span aria-hidden>{count}</span>
      <span className="sr-only">{label}</span>
    </span>
  );
}
