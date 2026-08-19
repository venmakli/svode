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
import {
  availabilityLabel,
  availabilityVariant,
  instructionAdapterLabel,
  instructionScopeLabel,
} from "./instruction-labels";

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
    [
      customBadgeField(
        "adapter",
        m.agent_context_adapter(),
        (row) => instructionAdapterLabel(row.adapterId),
        (row) => (
          <Badge variant="outline">
            {instructionAdapterLabel(row.adapterId)}
          </Badge>
        ),
      ),
      customBadgeField(
        "scope",
        m.agent_context_scope(),
        (row) => instructionScopeLabel(row.scope),
        (row) => (
          <Badge variant="outline">{instructionScopeLabel(row.scope)}</Badge>
        ),
      ),
      customBadgeField(
        "availability",
        m.agent_context_availability(),
        (row) => availabilityLabel(row.availability),
        (row) => (
          <Badge variant={availabilityVariant(row.availability)}>
            {availabilityLabel(row.availability)}
          </Badge>
        ),
      ),
    ];

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
          title: row.filename,
        };
      },
      fields,
      getRowId: (row) => row.id,
      id: "instructions",
      label: m.agent_context_instructions(),
      layout: {
        cardSize: "large",
        density: "comfortable",
        getTitle: (row) => row.filename,
        kind: "gallery",
        renderLeading: () => (
          <FileText className="size-4 text-muted-foreground" aria-hidden />
        ),
        renderOverlays: (row) => <InstructionCardOverlays row={row} />,
        visibleFields: ["adapter", "scope", "availability"],
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
    row.availability === "shadowed" ||
    row.availability === "compatibility_unknown" ||
    row.diagnostics.length > 0
      ? [row.availabilityReason, ...row.diagnostics]
          .filter(Boolean)
          .join(" · ") || availabilityLabel(row.availability)
      : null;

  if (!row.linkTargetPath && !warning) return null;

  return (
    <div className="absolute right-2 top-2 z-10 flex items-center gap-1">
      {row.linkTargetPath ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              className="inline-flex size-6 items-center justify-center rounded-md border bg-background/95 text-muted-foreground shadow-sm"
              aria-label={m.agent_context_link_tooltip({
                path: row.linkTargetPath,
              })}
              tabIndex={0}
            >
              <Link2 className="size-3.5" aria-hidden />
            </span>
          </TooltipTrigger>
          <TooltipContent>
            {m.agent_context_link_tooltip({ path: row.linkTargetPath })}
          </TooltipContent>
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

function customBadgeField(
  key: string,
  label: string,
  getValue: (row: AgentContextInstructionRow) => string,
  render: (row: AgentContextInstructionRow) => React.ReactNode,
): SystemCollectionFieldDescriptor<AgentContextInstructionRow> {
  return {
    getValue,
    key,
    label,
    valueSemantics: {
      kind: "custom",
      render: (_value, row) => render(row),
    },
  };
}
