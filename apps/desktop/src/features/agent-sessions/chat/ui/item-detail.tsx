import { Suspense } from "react";
import { FileTextDiff } from "@/features/changes/text-diff";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/shared/lib/utils";
import type {
  AgentActivityItemDto,
  AgentDetailBlockDto,
  AgentDetailOutcomeDto,
  AgentSessionKeyDto,
} from "../api/chat";
import { useItemDetail } from "../hooks/use-item-detail";
import * as m from "@/paraglide/messages.js";

/** The detail of a timeline item, read when it is shown. */
export function ItemDetail({
  session,
  item,
  className,
}: {
  session: AgentSessionKeyDto;
  item: AgentActivityItemDto;
  className?: string;
}) {
  const detail = useItemDetail(session, item, true);
  return <DetailView detail={detail} className={className} />;
}

export function DetailView({
  detail,
  className,
}: {
  detail: AgentDetailOutcomeDto | null;
  className?: string;
}) {
  if (!detail) {
    return (
      <div className={cn("flex flex-col gap-1.5", className)} aria-busy="true">
        <Skeleton className="h-4 w-3/4" />
        <Skeleton className="h-4 w-1/2" />
      </div>
    );
  }
  if (detail.outcome !== "available" || detail.blocks.length === 0) {
    return (
      <p className={cn("text-xs text-muted-foreground", className)}>
        {detailNotice(detail)}
      </p>
    );
  }
  return (
    <div className={cn("flex min-w-0 flex-col gap-2", className)}>
      {detail.blocks.map((block, index) => (
        <DetailBlock key={index} block={block} />
      ))}
    </div>
  );
}

/** The text of a read detail, or `null` when it has none to show. */
export function detailText(
  detail: AgentDetailOutcomeDto | null,
): string | null {
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

/** Why a read detail shows no blocks, or `null` when it has them. */
export function detailNotice(detail: AgentDetailOutcomeDto): string | null {
  if (detail.outcome === "error") {
    return m.sessions_chat_detail_error({ message: detail.message });
  }
  if (detail.outcome === "unavailable") {
    return detail.reason === "too_large"
      ? m.sessions_chat_detail_too_large()
      : detail.reason === "released"
        ? m.sessions_chat_detail_released()
        : m.sessions_chat_detail_not_provided();
  }
  if (detail.blocks.length === 0) return m.sessions_chat_detail_not_provided();
  return null;
}

const OUTPUT =
  "max-h-80 min-w-0 overflow-auto rounded-md bg-muted/60 px-3 py-2 font-mono text-xs leading-relaxed whitespace-pre-wrap break-words";

export function DetailBlock({ block }: { block: AgentDetailBlockDto }) {
  switch (block.type) {
    case "text":
      return (
        <pre tabIndex={0} className={OUTPUT}>
          {block.text}
        </pre>
      );
    case "excerpt":
      return (
        <pre tabIndex={0} className={OUTPUT}>
          {block.head}
          <span className="my-1 block text-center font-sans text-muted-foreground">
            {m.sessions_chat_detail_omitted({
              count: block.omittedChars.toLocaleString(),
            })}
          </span>
          {block.tail}
        </pre>
      );
    case "diff":
      return (
        <div className="min-w-0 overflow-hidden rounded-md border">
          <div className="truncate border-b bg-muted/40 px-3 py-1 font-mono text-xs text-muted-foreground">
            {block.path}
          </div>
          <div className="max-h-96 overflow-auto">
            <Suspense fallback={<Skeleton className="m-3 h-16" />}>
              <FileTextDiff
                path={block.path}
                before={block.oldText}
                after={block.newText}
                fallback={<pre className={OUTPUT}>{block.newText}</pre>}
              />
            </Suspense>
          </div>
        </div>
      );
    case "terminal":
      return (
        <p className="text-xs text-muted-foreground">
          {m.sessions_chat_detail_agent_terminal()}
        </p>
      );
  }
}
