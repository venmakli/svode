import { useState, type ReactNode } from "react";
import {
  AlertCircle,
  Brain,
  ChevronRight,
  CircleCheck,
  CircleDashed,
  CircleSlash,
  FileText,
  Globe,
  ListChecks,
  Loader2,
  MoveRight,
  Pencil,
  Search,
  SquareTerminal,
  Trash2,
  Wrench,
} from "lucide-react";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Marker, MarkerContent, MarkerIcon } from "@/components/ui/marker";
import { Message, MessageContent } from "@/components/ui/message";
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@/components/ui/message-scroller";
import {
  MarkdownReader,
  type MarkdownReaderPolicy,
} from "@/shared/ui/markdown-reader";
import { cn } from "@/shared/lib/utils";
import type {
  AgentActivityItemDto,
  AgentDetailOutcomeDto,
  AgentSessionKeyDto,
  AgentSessionSnapshotDto,
} from "../api/chat";
import { useItemDetail } from "../hooks/use-item-detail";
import { messageParts } from "../model/attachments";
import { AttachmentBadge, ImageMark } from "./attachment-badge";
import {
  isExpanded,
  isSummaryExpanded,
  shownEntries,
  summaryKey,
  type ManualExpansion,
} from "../model/expansion";
import {
  projectTimeline,
  type InteractionRecord,
  type NoticeItem,
  type OutcomeItem,
  type TimelineEntry,
  type TimelineTurn,
  type ToolRow,
} from "../model/timeline";
import { formatDuration } from "../model/format";
import { ItemDetail } from "./item-detail";
import * as m from "@/paraglide/messages.js";

/** Links in agent text stay text: the chat opens nothing on its own. */
const agentTextPolicy: MarkdownReaderPolicy = {
  openLink: () => undefined,
  resolveImageSource: () => null,
  resolveLink: () => null,
};

/**
 * The session timeline (Stage 10 `04`): turns of the runtime snapshot with
 * the user's messages and the agent's narrative as the main text, tool
 * calls as compact rows with detail on request, finished turns folded into
 * a summary row. One scroll owner follows the end only while the user is
 * there.
 */
export function ChatTimeline({
  session,
  snapshot,
  header,
}: {
  session: AgentSessionKeyDto;
  snapshot: AgentSessionSnapshotDto;
  /** History state shown above the first turn. */
  header?: ReactNode;
}) {
  const [manual, setManual] = useState<ManualExpansion>({});
  const toggle = (id: string, open: boolean) =>
    setManual((current) => ({ ...current, [id]: open }));
  const turns = projectTimeline(snapshot);

  return (
    <MessageScrollerProvider autoScroll defaultScrollPosition="end">
      <MessageScroller className="min-h-0 flex-1">
        <MessageScrollerViewport
          aria-label={m.sessions_chat_timeline_label()}
          className="px-6"
        >
          <MessageScrollerContent className="mx-auto w-full max-w-3xl gap-4 py-4">
            {header}
            {turns.map((turn) => (
              <TurnView
                key={turn.id}
                session={session}
                turn={turn}
                manual={manual}
                onToggle={toggle}
              />
            ))}
          </MessageScrollerContent>
        </MessageScrollerViewport>
        <MessageScrollerButton aria-label={m.sessions_chat_scroll_to_end()} />
      </MessageScroller>
    </MessageScrollerProvider>
  );
}

function TurnView({
  session,
  turn,
  manual,
  onToggle,
}: {
  session: AgentSessionKeyDto;
  turn: TimelineTurn;
  manual: ManualExpansion;
  onToggle: (id: string, open: boolean) => void;
}) {
  const entries = shownEntries(manual, turn);
  const summary = turn.summary;
  const summaryRow = summary ? (
    <MessageScrollerItem key={summaryKey(turn)}>
      <TurnSummaryRow
        count={summary.count}
        durationMs={summary.durationMs}
        open={isSummaryExpanded(manual, turn)}
        onOpenChange={(open) => onToggle(summaryKey(turn), open)}
      />
    </MessageScrollerItem>
  ) : null;
  const rows: ReactNode[] = [];
  if (summary && summary.afterId === null) rows.push(summaryRow);
  for (const entry of entries) {
    rows.push(
      <MessageScrollerItem
        key={entry.id}
        messageId={entry.kind === "user" ? entry.id : undefined}
        scrollAnchor={entry.kind === "user"}
      >
        <EntryView
          session={session}
          turn={turn}
          entry={entry}
          open={isExpanded(manual, turn, entry)}
          onOpenChange={(open) => onToggle(entry.id, open)}
        />
      </MessageScrollerItem>,
    );
    if (summary && summary.afterId === entry.id) rows.push(summaryRow);
  }
  return <>{rows}</>;
}

function TurnSummaryRow({
  count,
  durationMs,
  open,
  onOpenChange,
}: {
  count: number;
  durationMs: number | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const parts = [
    durationMs !== null
      ? m.sessions_chat_turn_worked({ duration: formatDuration(durationMs) })
      : m.sessions_chat_turn(),
    m.sessions_chat_turn_items({ count }),
  ];
  return (
    <button
      type="button"
      aria-expanded={open}
      onClick={() => onOpenChange(!open)}
      className="flex w-full items-center gap-2 rounded-md py-1 text-left text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
    >
      <ChevronRight
        className={cn("size-3.5 transition-transform", open && "rotate-90")}
      />
      <span>{parts.join(" · ")}</span>
      <span className="h-px flex-1 bg-border" />
    </button>
  );
}

function EntryView({
  session,
  turn,
  entry,
  open,
  onOpenChange,
}: {
  session: AgentSessionKeyDto;
  turn: TimelineTurn;
  entry: TimelineEntry;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  switch (entry.kind) {
    case "user":
      return (
        <Message align="end">
          <MessageContent>
            <Bubble variant="secondary" align="end">
              <BubbleContent className="whitespace-pre-wrap">
                <UserMessageText session={session} item={entry.item} />
              </BubbleContent>
            </Bubble>
          </MessageContent>
        </Message>
      );
    case "message":
      return (
        <Message>
          <MessageContent>
            <ItemText session={session} item={entry.item} markdown />
          </MessageContent>
        </Message>
      );
    case "reasoning":
      return (
        <Disclosure
          open={open}
          onOpenChange={onOpenChange}
          icon={<Brain />}
          title={
            turn.live && turn.entries.at(-1)?.id === entry.id
              ? m.sessions_chat_reasoning_live()
              : m.sessions_chat_reasoning()
          }
        >
          <div className="text-sm whitespace-pre-wrap text-muted-foreground">
            <ItemText session={session} item={entry.item} />
          </div>
        </Disclosure>
      );
    case "tools":
      return (
        <ToolGroup
          session={session}
          rows={entry.rows}
          open={open}
          onOpenChange={onOpenChange}
        />
      );
    case "plan":
      return <PlanBlock item={entry.item} />;
    case "question":
      return <QuestionRecord item={entry.item} />;
    case "notice":
      return (
        <Notice
          item={entry.item}
          count={entry.count}
          open={open}
          onOpenChange={onOpenChange}
        />
      );
    case "outcome":
      return <OutcomeMarker item={entry.item} />;
  }
}

/** The text of an item: its summary, or its detail when it is longer. */
function ItemText({
  session,
  item,
  markdown = false,
}: {
  session: AgentSessionKeyDto;
  item: AgentActivityItemDto;
  markdown?: boolean;
}) {
  const detail = useItemDetail(session, item, item.hasDetail);
  const text = item.hasDetail ? (detailText(detail) ?? item.summary) : item.summary;
  if (!markdown) return <>{text}</>;
  return <MarkdownReader content={text} policy={agentTextPolicy} />;
}

/**
 * The user's message with its attachments as badges: its segments, and
 * links the agent replayed as text; anything unrecognized stays text.
 */
function UserMessageText({
  session,
  item,
}: {
  session: AgentSessionKeyDto;
  item: Extract<AgentActivityItemDto, { kind: "user_message" }>;
}) {
  const detail = useItemDetail(session, item, item.hasDetail);
  const text = item.hasDetail ? (detailText(detail) ?? item.summary) : item.summary;
  return messageParts(item.segments, text).map((part, index) => {
    switch (part.type) {
      case "text":
        return <span key={index}>{part.text}</span>;
      case "attachment":
        return (
          <AttachmentBadge
            key={index}
            attachment={part.attachment}
            variant="outline"
            className="bg-background"
          />
        );
      case "image":
        return <ImageMark key={index} name={part.name} />;
    }
  });
}

function detailText(detail: AgentDetailOutcomeDto | null): string | null {
  if (detail?.outcome !== "available") return null;
  const block = detail.blocks[0];
  if (block?.type === "text") return block.text;
  if (block?.type === "excerpt") {
    return `${block.head}\n\n${m.sessions_chat_detail_omitted({
      count: block.omittedChars.toLocaleString(),
    })}\n\n${block.tail}`;
  }
  return null;
}

function Disclosure({
  open,
  onOpenChange,
  icon,
  title,
  meta,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  icon: ReactNode;
  title: ReactNode;
  meta?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Collapsible open={open} onOpenChange={onOpenChange}>
      <CollapsibleTrigger className="group/disclosure flex w-full min-w-0 items-center gap-2 rounded-md py-1 text-left text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 [&_svg:not([class*='size-'])]:size-4">
        <span className="shrink-0">{icon}</span>
        <span className="min-w-0 truncate">{title}</span>
        {meta}
        <ChevronRight className="ms-auto size-3.5 shrink-0 transition-transform group-data-[state=open]/disclosure:rotate-90" />
      </CollapsibleTrigger>
      <CollapsibleContent className="ps-6 pt-1">{children}</CollapsibleContent>
    </Collapsible>
  );
}

const TOOL_ICONS: Record<string, ReactNode> = {
  read: <FileText />,
  edit: <Pencil />,
  delete: <Trash2 />,
  move: <MoveRight />,
  search: <Search />,
  execute: <SquareTerminal />,
  think: <Brain />,
  fetch: <Globe />,
  switch_mode: <ListChecks />,
  other: <Wrench />,
};

function ToolGroup({
  session,
  rows,
  open,
  onOpenChange,
}: {
  session: AgentSessionKeyDto;
  rows: ToolRow[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  if (rows.length === 1) {
    return <ToolRowView session={session} row={rows[0]} />;
  }
  const last = rows[rows.length - 1].item;
  return (
    <Disclosure
      open={open}
      onOpenChange={onOpenChange}
      icon={<Wrench />}
      title={m.sessions_chat_tools({ count: rows.length })}
      meta={
        <span className="min-w-0 truncate text-xs text-muted-foreground/80">
          {last.summary}
        </span>
      }
    >
      <div className="flex flex-col">
        {rows.map((row) => (
          <ToolRowView key={row.item.id} session={session} row={row} />
        ))}
      </div>
    </Disclosure>
  );
}

function ToolRowView({ session, row }: { session: AgentSessionKeyDto; row: ToolRow }) {
  const [open, setOpen] = useState(false);
  const { item, permission } = row;
  return (
    <Disclosure
      open={open}
      onOpenChange={setOpen}
      icon={TOOL_ICONS[item.tool] ?? TOOL_ICONS.other}
      title={item.summary || m.sessions_chat_tool_untitled()}
      meta={
        <>
          {permission && <PermissionOutcome record={permission} />}
          <ToolStatus status={item.status} />
        </>
      }
    >
      {open && <ItemDetail session={session} item={item} />}
    </Disclosure>
  );
}

function ToolStatus({ status }: { status: AgentActivityItemDto["status"] }) {
  switch (status) {
    case "in_progress":
      return (
        <Loader2
          className="size-3.5 shrink-0 animate-spin"
          aria-label={m.sessions_chat_tool_running()}
        />
      );
    case "failed":
      return (
        <AlertCircle
          className="size-3.5 shrink-0 text-destructive"
          aria-label={m.sessions_chat_tool_failed()}
        />
      );
    case "completed":
      return (
        <CircleCheck
          className="size-3.5 shrink-0"
          aria-label={m.sessions_chat_tool_completed()}
        />
      );
    default:
      return (
        <CircleDashed
          className="size-3.5 shrink-0"
          aria-label={m.sessions_chat_tool_pending()}
        />
      );
  }
}

function interactionOutcome(record: InteractionRecord): string {
  switch (record.state) {
    case "answered":
      if (record.declined) return m.sessions_chat_request_declined();
      return record.option
        ? m.sessions_chat_request_answered_option({ option: record.option })
        : m.sessions_chat_request_answered();
    case "cancelled":
      return m.sessions_chat_request_cancelled();
    case "expired":
      return m.sessions_chat_request_expired();
    case "pending":
      return "";
  }
}

function PermissionOutcome({ record }: { record: InteractionRecord }) {
  return (
    <span className="shrink-0 rounded-sm bg-muted px-1.5 text-xs text-muted-foreground">
      {interactionOutcome(record)}
    </span>
  );
}

function QuestionRecord({ item }: { item: InteractionRecord }) {
  return (
    <Marker>
      <MarkerIcon>
        <ListChecks />
      </MarkerIcon>
      <MarkerContent>
        {item.summary} — {interactionOutcome(item)}
      </MarkerContent>
    </Marker>
  );
}

function PlanBlock({ item }: { item: Extract<AgentActivityItemDto, { kind: "plan" }> }) {
  return (
    <section
      aria-label={m.sessions_chat_plan()}
      className="flex flex-col gap-1.5 rounded-lg border px-3 py-2"
    >
      <h3 className="text-xs font-medium text-muted-foreground">
        {m.sessions_chat_plan()}
      </h3>
      <ol className="flex flex-col gap-1">
        {item.entries.map((entry, index) => (
          <li key={index} className="flex items-start gap-2 text-sm">
            {entry.status === "completed" ? (
              <CircleCheck className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            ) : entry.status === "in_progress" ? (
              <Loader2 className="mt-0.5 size-4 shrink-0 animate-spin text-muted-foreground" />
            ) : (
              <CircleDashed className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            )}
            <span
              className={cn(
                "min-w-0 break-words",
                entry.status === "completed" && "text-muted-foreground line-through",
              )}
            >
              {entry.content}
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}

function noticeTitle(item: NoticeItem): string {
  switch (item.kind) {
    case "error":
      return m.sessions_chat_notice_error();
    case "generic":
      return m.sessions_chat_notice_generic({ label: item.label });
    case "mode_change":
      return m.sessions_chat_notice_mode({ mode: item.summary });
    case "config_change":
      return m.sessions_chat_notice_config();
    case "interaction":
      return `${item.summary} — ${interactionOutcome(item)}`;
  }
}

function Notice({
  item,
  count,
  open,
  onOpenChange,
}: {
  item: NoticeItem;
  count: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const title = noticeTitle(item);
  const repeats =
    count > 1 ? (
      <span className="shrink-0 text-xs">{m.sessions_chat_repeats({ count })}</span>
    ) : null;
  if (item.kind === "error" && item.summary) {
    return (
      <Disclosure
        open={open}
        onOpenChange={onOpenChange}
        icon={<AlertCircle className="text-destructive" />}
        title={<span className="text-destructive">{title}</span>}
        meta={repeats}
      >
        <pre className="max-h-60 overflow-auto rounded-md bg-muted/60 px-3 py-2 font-mono text-xs whitespace-pre-wrap break-words">
          {item.summary}
        </pre>
      </Disclosure>
    );
  }
  return (
    <Marker>
      <MarkerIcon>{item.kind === "error" ? <AlertCircle /> : <Wrench />}</MarkerIcon>
      <MarkerContent>{title}</MarkerContent>
      {repeats}
    </Marker>
  );
}

function OutcomeMarker({ item }: { item: OutcomeItem }) {
  let text: string;
  let failed = false;
  if (item.kind === "interrupted") {
    text = m.sessions_chat_outcome_interrupted();
    failed = true;
  } else {
    switch (item.reason) {
      case "cancelled":
        text = m.sessions_chat_outcome_cancelled();
        break;
      case "max_tokens":
        text = m.sessions_status_reason_max_tokens();
        break;
      case "max_turn_requests":
        text = m.sessions_status_reason_max_turn_requests();
        break;
      case "refusal":
        text = m.sessions_status_reason_refusal();
        break;
      default:
        text = m.sessions_chat_outcome_error();
        failed = true;
    }
  }
  return (
    <Marker variant="separator" className={cn(failed && "text-destructive")}>
      <MarkerIcon>{failed ? <AlertCircle /> : <CircleSlash />}</MarkerIcon>
      <MarkerContent>{text}</MarkerContent>
    </Marker>
  );
}
