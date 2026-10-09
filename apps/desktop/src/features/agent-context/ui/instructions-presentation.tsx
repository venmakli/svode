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
  defineCollectionPresentation,
  type CollectionPresentationDescriptor,
  type CollectionPresentationState,
} from "@/features/collection";
import type { CollectionDetailContent } from "@/features/collection/app-shell";
import {
  defineDomainSpecificCollectionProperty,
  type CollectionPropertyDefinition,
} from "@/features/properties";
import * as m from "@/paraglide/messages.js";

import type { AgentContextInstructionRow } from "../model/types";
import { AgentContextArtifactOpenWith } from "./artifact-open-with";
import { AgentContextInstructionDetail } from "./instruction-detail";
import { sourceLinkKindLabel } from "./provenance-labels";

export function createAgentContextInstructionsPresentation({
  onActivate,
  state,
}: {
  onActivate?: CollectionPresentationDescriptor<AgentContextInstructionRow>["onActivate"];
  state: CollectionPresentationState<AgentContextInstructionRow>;
}) {
  const properties: readonly CollectionPropertyDefinition<AgentContextInstructionRow>[] =
    [instructionSourceField()];

  return defineCollectionPresentation<AgentContextInstructionRow>({
    descriptor: {
      onActivate,
      properties,
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
        visibleProperties: ["source"],
      },
      query: {},
    },
    state,
  });
}

export function createInstructionDetailContent(
  row: AgentContextInstructionRow,
): CollectionDetailContent {
  return {
    content: <AgentContextInstructionDetail row={row} />,
    description: m.agent_context_detail_description(),
    identity: { icon: <FileText />, name: row.filename },
    openWith: (
      <AgentContextArtifactOpenWith
        canonicalArtifactPath={row.canonicalPath}
        ownerRoot={row.ownerPath}
      />
    ),
    title: row.filename,
  };
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

function instructionSourceField(): CollectionPropertyDefinition<AgentContextInstructionRow> {
  return defineDomainSpecificCollectionProperty({
    featureId: "agent-context",
    getValue: (row) => [row.location, row.support],
    key: "source",
    label: m.agent_context_source(),
    render: (_value, row) => {
      const showGlobal = row.location === "global";
      const showRecognized = row.support === "svode_recognized";
      if (!showGlobal && !showRecognized) return null;
      return (
        <div className="flex flex-wrap gap-1">
          {showGlobal ? (
            <Badge variant="outline">{m.agent_context_location_global()}</Badge>
          ) : null}
          {showRecognized ? (
            <Badge variant="outline">
              {m.agent_context_source_recognized()}
            </Badge>
          ) : null}
        </div>
      );
    },
  });
}

function instructionLinkTooltip(row: AgentContextInstructionRow) {
  return m.agent_context_instruction_link_tooltip({
    kind: sourceLinkKindLabel(row.linkKind),
    path: row.discoveryPath,
    target: row.linkTargetPath ?? row.canonicalPath,
  });
}
