import { FileText, Link2, TriangleAlert } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  defineSystemCollectionPresentation,
  type SystemCollectionFieldDescriptor,
  type SystemCollectionPresentationState,
} from "@/features/collection/system";
import * as m from "@/paraglide/messages.js";

import type { AgentContextInstructionRow } from "../model/types";
import type { ArtifactOpener } from "../api/agent-context-api";
import { AgentContextInstructionDetail } from "./instruction-detail";
import { sourceLinkKindLabel } from "./provenance-labels";

export function createAgentContextInstructionsPresentation({
  artifactOpeners = [],
  onOpenArtifact,
  onDetailRequested,
  state,
}: {
  artifactOpeners?: readonly ArtifactOpener[];
  onOpenArtifact?(input: {
    ownerRoot: string;
    canonicalArtifactPath: string;
    tool: ArtifactOpener["id"];
  }): void | Promise<void>;
  onDetailRequested?(rowId: string): void;
  state: SystemCollectionPresentationState<AgentContextInstructionRow>;
}) {
  const fields: readonly SystemCollectionFieldDescriptor<AgentContextInstructionRow>[] =
    [instructionSourceField()];

  return defineSystemCollectionPresentation<AgentContextInstructionRow>({
    descriptor: {
      createDetailRequest: (row) => {
        onDetailRequested?.(row.id);
        return {
          content: <AgentContextInstructionDetail row={row} />,
          description: (
            <span className="sr-only">
              {m.agent_context_detail_description()}
            </span>
          ),
          title: instructionDetailTitle(row),
        };
      },
      fields,
      getRowId: (row) => row.id,
      id: "instructions",
      label: m.agent_context_instructions(),
      layout: {
        cardSize: "medium",
        density: "compact",
        getTitle: (row) => row.filename,
        kind: "gallery",
        renderLeading: () => (
          <FileText className="size-4 text-muted-foreground" aria-hidden />
        ),
        renderOverlays: (row) => <InstructionCardOverlays row={row} />,
        visibleFields: ["source"],
      },
      query: {},
      rowActions: artifactOpeners.map((opener) => ({
        getState: () => ({ status: "idle" as const }),
        id: `open-in-${opener.id}`,
        label: m.agent_context_open_in({ name: opener.label }),
        run: (row) =>
          onOpenArtifact?.({
            canonicalArtifactPath: row.canonicalPath,
            ownerRoot: row.ownerPath,
            tool: opener.id,
          }),
      })),
    },
    state,
  });
}

export function instructionDetailTitle(row: AgentContextInstructionRow) {
  return (
    <span className="flex min-w-0 items-center gap-3 text-left">
      <FileText className="size-6 shrink-0 text-muted-foreground" aria-hidden />
      <span className="min-w-0 break-words [overflow-wrap:anywhere]">
        {row.filename}
      </span>
    </span>
  );
}

export function AgentContextInstructionsEmpty() {
  return (
    <Empty className="min-h-48 flex-none border">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <FileText />
        </EmptyMedia>
        <EmptyTitle>{m.agent_context_empty_title()}</EmptyTitle>
        <EmptyDescription>
          {m.agent_context_empty_description()}
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

function InstructionCardOverlays({ row }: { row: AgentContextInstructionRow }) {
  const warning =
    row.health === "degraded"
      ? row.healthReasons.join(" · ") || m.agent_context_health_degraded()
      : null;

  if (row.linkKind === "direct" && !warning) return null;

  return (
    <div className="absolute right-2 top-2 z-10 flex items-center gap-1">
      {row.linkKind !== "direct" ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              className="inline-flex size-6 items-center justify-center rounded-md border bg-background/95 text-muted-foreground shadow-sm"
              aria-label={instructionLinkTooltip(row)}
              tabIndex={0}
            >
              <Link2 className="size-3.5" aria-hidden />
            </span>
          </TooltipTrigger>
          <TooltipContent>{instructionLinkTooltip(row)}</TooltipContent>
        </Tooltip>
      ) : null}
      {warning ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              className="inline-flex size-6 items-center justify-center rounded-md border border-destructive/30 bg-background/95 text-destructive shadow-sm"
              aria-label={m.agent_context_warning_tooltip({ reason: warning })}
              tabIndex={0}
            >
              <TriangleAlert className="size-3.5" aria-hidden />
            </span>
          </TooltipTrigger>
          <TooltipContent>{warning}</TooltipContent>
        </Tooltip>
      ) : null}
    </div>
  );
}

function instructionSourceField(): SystemCollectionFieldDescriptor<AgentContextInstructionRow> {
  return {
    getValue: (row) => [row.location, row.support],
    key: "source",
    label: m.agent_context_source(),
    valueSemantics: {
      kind: "custom",
      render: (_value, row) => {
        const showGlobal = row.location === "global";
        const showRecognized = row.support === "svode_recognized";
        if (!showGlobal && !showRecognized) return null;
        return (
          <div className="flex flex-wrap gap-1">
            {showGlobal ? (
              <Badge variant="outline">
                {m.agent_context_location_global()}
              </Badge>
            ) : null}
            {showRecognized ? (
              <Badge variant="outline">
                {m.agent_context_source_recognized()}
              </Badge>
            ) : null}
          </div>
        );
      },
    },
  };
}

function instructionLinkTooltip(row: AgentContextInstructionRow) {
  return m.agent_context_instruction_link_tooltip({
    kind: sourceLinkKindLabel(row.linkKind),
    path: row.discoveryPath,
    target: row.linkTargetPath ?? row.canonicalPath,
  });
}
