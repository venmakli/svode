import { useState } from "react";
import {
  ChevronRight,
  FileMinus,
  FilePen,
  FilePlus,
  FileSymlink,
  FileText,
} from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/shared/lib/utils";
import type { AgentActivityItemDto, AgentSessionKeyDto } from "../api/chat";
import { useOpenAttachment } from "../hooks/use-attachment-opener";
import { useOpenFileChanges } from "../hooks/use-changes-opener";
import {
  useChangedFileStates,
  type ChangedFileState,
} from "../hooks/use-changed-file-states";
import { useItemDetail } from "../hooks/use-item-detail";
import { attachmentOf } from "../model/attachments";
import type {
  ChangedFile,
  FileChangeKind,
  LineCounts,
  TurnChanges,
} from "../model/changed-files";
import { DetailBlock, DetailView } from "./item-detail";
import * as m from "@/paraglide/messages.js";

/**
 * The files a finished turn changed, under the agent's last message (Stage
 * 10 `08` R2): one row with the count and the lines of the turn's diffs,
 * opening into the files; each file unfolds its diff of this turn and opens
 * by its name.
 */
export function TurnChangedFiles({
  session,
  changes,
  open,
  onOpenChange,
}: {
  session: AgentSessionKeyDto;
  changes: TurnChanges;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const states = useChangedFileStates(
    changes.files.map((file) => file.path),
    open,
  );
  return (
    <Collapsible open={open} onOpenChange={onOpenChange}>
      <CollapsibleTrigger className="group/files flex w-full min-w-0 items-center gap-2 rounded-md py-1 text-left text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50">
        <ChevronRight className="size-3.5 shrink-0 transition-transform group-data-[state=open]/files:rotate-90" />
        <span>
          {m.sessions_chat_changed_files({ count: changes.files.length })}
        </span>
        {changes.lines && <LineCountsView lines={changes.lines} />}
      </CollapsibleTrigger>
      <CollapsibleContent className="pt-1">
        <ul className="flex flex-col">
          {changes.files.map((file) => (
            <ChangedFileRow
              key={file.path}
              session={session}
              file={file}
              state={states.get(file.path)}
            />
          ))}
        </ul>
      </CollapsibleContent>
    </Collapsible>
  );
}

function ChangedFileRow({
  session,
  file,
  state,
}: {
  session: AgentSessionKeyDto;
  file: ChangedFile;
  state: ChangedFileState | undefined;
}) {
  const [diffOpen, setDiffOpen] = useState(false);
  const openAttachment = useOpenAttachment();
  const openChanges = useOpenFileChanges();
  const hasDiff = file.lines !== null && file.diffCalls.length > 0;
  // A deleted file without unsaved changes has nothing left to open.
  const removed = state?.exists === false && !state.dirty;
  const open = () => {
    if (!state || removed) return;
    if (state.dirty && state.location && openChanges) {
      openChanges({
        spacePath: state.location.spacePath,
        path: state.location.path,
        name: file.name,
      });
      return;
    }
    openAttachment?.(attachmentOf(file.path, file.name));
  };
  return (
    <li className="flex flex-col">
      <div className="flex min-w-0 items-center gap-1.5 py-0.5 text-sm">
        {hasDiff ? (
          <button
            type="button"
            aria-expanded={diffOpen}
            aria-label={m.sessions_chat_changed_file_diff({ name: file.name })}
            onClick={() => setDiffOpen(!diffOpen)}
            className="flex size-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            <ChevronRight
              className={cn(
                "size-3.5 transition-transform",
                diffOpen && "rotate-90",
              )}
            />
          </button>
        ) : (
          <span className="size-5 shrink-0" />
        )}
        <ChangeIcon change={file.change} />
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-disabled={removed}
              onClick={open}
              className={cn(
                "min-w-0 truncate rounded-sm text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
                removed
                  ? "cursor-default text-muted-foreground line-through"
                  : "hover:underline",
              )}
            >
              {file.name}
            </button>
          </TooltipTrigger>
          <TooltipContent className="break-all">
            {removed ? m.sessions_chat_changed_file_removed() : file.path}
          </TooltipContent>
        </Tooltip>
        {file.lines && (
          <LineCountsView lines={file.lines} className="ms-auto" />
        )}
      </div>
      {diffOpen && (
        <div className="flex flex-col gap-2 py-1 ps-6">
          {file.diffCalls.map((item) => (
            <CallDiffs
              key={item.id}
              session={session}
              item={item}
              path={file.path}
            />
          ))}
        </div>
      )}
    </li>
  );
}

/** The diffs of `path` one tool call sent, read when shown. */
function CallDiffs({
  session,
  item,
  path,
}: {
  session: AgentSessionKeyDto;
  item: AgentActivityItemDto;
  path: string;
}) {
  const detail = useItemDetail(session, item, true);
  if (detail?.outcome !== "available") return <DetailView detail={detail} />;
  return detail.blocks
    .filter((block) => block.type === "diff" && block.path === path)
    .map((block, index) => <DetailBlock key={index} block={block} />);
}

function LineCountsView({
  lines,
  className,
}: {
  lines: LineCounts;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "flex shrink-0 items-center gap-1.5 font-mono text-xs tabular-nums",
        className,
      )}
      aria-label={m.changes_stats({
        added: String(lines.added),
        removed: String(lines.removed),
      })}
    >
      <span className="text-[var(--property-green)]">+{lines.added}</span>
      <span className="text-destructive">−{lines.removed}</span>
    </span>
  );
}

const CHANGE_ICONS = {
  created: FilePlus,
  modified: FilePen,
  deleted: FileMinus,
  moved: FileSymlink,
};

function changeLabel(change: FileChangeKind): string {
  switch (change) {
    case "created":
      return m.sessions_chat_changed_file_created();
    case "modified":
      return m.sessions_chat_changed_file_modified();
    case "deleted":
      return m.sessions_chat_changed_file_deleted();
    case "moved":
      return m.sessions_chat_changed_file_moved();
  }
}

function ChangeIcon({ change }: { change: FileChangeKind | null }) {
  const Icon = change ? CHANGE_ICONS[change] : FileText;
  return (
    <Icon
      className="size-4 shrink-0 text-muted-foreground"
      role={change ? "img" : undefined}
      aria-label={change ? changeLabel(change) : undefined}
      aria-hidden={change ? undefined : true}
    />
  );
}
