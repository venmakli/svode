import { Link2, Sparkles, TriangleAlert } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  defineSystemCollectionPresentation,
  normalizeSystemCollectionSearchText,
  type SystemCollectionFieldDescriptor,
  type SystemCollectionFilterEditorInput,
  type SystemCollectionPresentationState,
} from "@/features/collection/system";
import * as m from "@/paraglide/messages.js";

import type {
  AgentContextScope,
  AgentContextSkillRow,
  SupportedAdapterId,
} from "../model/types";
import type { ArtifactOpener } from "../api/agent-context-api";
import {
  instructionAdapterLabel,
  instructionScopeLabel,
} from "./instruction-labels";
import { AgentContextSkillDetail, skillWarnings } from "./skill-detail";

export function createAgentContextSkillsPresentation({
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
  state: SystemCollectionPresentationState<AgentContextSkillRow>;
}) {
  const fields: readonly SystemCollectionFieldDescriptor<AgentContextSkillRow>[] =
    [
      multiValueField(
        "client",
        m.agent_context_adapter(),
        (row) => row.clients,
        ["codex", "claude-code"],
        instructionAdapterLabel,
        m.agent_context_filter_client_placeholder(),
      ),
      multiValueField(
        "scope",
        m.agent_context_scope(),
        (row) => row.scopes,
        ["project", "personal"],
        instructionScopeLabel,
        m.agent_context_filter_scope_placeholder(),
      ),
    ];

  return defineSystemCollectionPresentation<AgentContextSkillRow>({
    descriptor: {
      createDetailRequest: (row) => {
        onDetailRequested?.(row.id);
        return {
          content: <AgentContextSkillDetail row={row} />,
          description: (
            <span className="sr-only">
              {m.agent_context_skill_detail_description()}
            </span>
          ),
          title: (
            <span className="flex min-w-0 items-center gap-2">
              <span className="truncate">{row.name}</span>
              <Badge variant="outline">{m.agent_context_skill_label()}</Badge>
            </span>
          ),
        };
      },
      fields,
      getRowId: (row) => row.id,
      id: "skills",
      label: m.agent_context_skills(),
      layout: {
        cardSize: "large",
        density: "comfortable",
        getDescription: (row) => (
          <span className="line-clamp-3 leading-relaxed">
            {row.description}
          </span>
        ),
        getTitle: (row) => row.name,
        kind: "gallery",
        renderLeading: () => (
          <Sparkles className="size-4 text-muted-foreground" aria-hidden />
        ),
        renderOverlays: (row) => <SkillCardOverlays row={row} />,
        visibleFields: ["client", "scope"],
      },
      query: {
        defaultCompare: compareSkillsByDefault,
        getSearchText: (row) => `${row.name} ${row.description}`,
      },
      rowActions: artifactOpeners.map((opener) => ({
        getState: () => ({ status: "idle" as const }),
        id: `open-in-${opener.id}`,
        label: m.agent_context_open_in({ name: opener.label }),
        run: (row) =>
          onOpenArtifact?.({
            canonicalArtifactPath: row.manifestPath,
            ownerRoot: skillOwnerRoot(row),
            tool: opener.id,
          }),
      })),
    },
    state,
  });
}

function skillOwnerRoot(row: AgentContextSkillRow): string {
  return row.ownerPath;
}

export function AgentContextSkillsEmpty() {
  return (
    <Empty className="min-h-48 flex-none border">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Sparkles />
        </EmptyMedia>
        <EmptyTitle>{m.agent_context_skills_empty_title()}</EmptyTitle>
        <EmptyDescription>
          {m.agent_context_skills_empty_description()}
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

export function compareSkillsByDefault(
  left: AgentContextSkillRow,
  right: AgentContextSkillRow,
) {
  return (
    compareText(
      normalizeSystemCollectionSearchText(left.name),
      normalizeSystemCollectionSearchText(right.name),
    ) || compareText(left.canonicalPath, right.canonicalPath)
  );
}

function multiValueField<Value extends SupportedAdapterId | AgentContextScope>(
  key: string,
  label: string,
  getValues: (row: AgentContextSkillRow) => readonly Value[],
  options: readonly Value[],
  getLabel: (value: Value) => string,
  placeholder: string,
): SystemCollectionFieldDescriptor<AgentContextSkillRow> {
  return {
    filter: {
      kind: "custom",
      matches: (row, rule) =>
        typeof rule.value === "string" &&
        getValues(row).includes(rule.value as Value),
      operators: ["="],
      renderEditor: (input) => (
        <SkillFilterEditor
          {...input}
          getLabel={getLabel}
          options={options}
          placeholder={placeholder}
        />
      ),
      validate: (rule) =>
        rule.operator === "=" &&
        typeof rule.value === "string" &&
        options.includes(rule.value as Value),
    },
    getValue: getValues,
    key,
    label,
    valueSemantics: {
      kind: "custom",
      render: (_value, row) => (
        <div className="flex flex-wrap gap-1">
          {getValues(row).map((value) => (
            <Badge key={value} variant="outline">
              {getLabel(value)}
            </Badge>
          ))}
        </div>
      ),
    },
  };
}

function SkillFilterEditor<Value extends string>({
  getLabel,
  onChange,
  options,
  placeholder,
  rule,
}: SystemCollectionFilterEditorInput & {
  getLabel(value: Value): string;
  options: readonly Value[];
  placeholder: string;
}) {
  return (
    <Select
      value={typeof rule.value === "string" ? rule.value : undefined}
      onValueChange={(value) => onChange({ ...rule, value })}
    >
      <SelectTrigger className="w-full">
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          {options.map((option) => (
            <SelectItem key={option} value={option}>
              {getLabel(option)}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}

function SkillCardOverlays({ row }: { row: AgentContextSkillRow }) {
  const linkedPaths = row.aliases
    .filter((alias) => alias.linkKind !== "direct")
    .map((alias) => alias.discoveryPath);
  const warnings = skillWarnings(row);
  if (linkedPaths.length === 0 && warnings.length === 0) return null;

  return (
    <div className="absolute right-2 top-2 z-10 flex items-center gap-1">
      {linkedPaths.length > 0 ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              className="inline-flex size-6 items-center justify-center rounded-md border bg-background/95 text-muted-foreground shadow-sm"
              aria-label={m.agent_context_link_tooltip({
                path: linkedPaths.join(", "),
              })}
              tabIndex={0}
            >
              <Link2 className="size-3.5" aria-hidden />
            </span>
          </TooltipTrigger>
          <TooltipContent>
            {m.agent_context_link_tooltip({
              path: linkedPaths.join(", "),
            })}
          </TooltipContent>
        </Tooltip>
      ) : null}
      {warnings.length > 0 ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              className="inline-flex size-6 items-center justify-center rounded-md border border-destructive/30 bg-background/95 text-destructive shadow-sm"
              aria-label={m.agent_context_warning_tooltip({
                reason: warnings.join(" · "),
              })}
              tabIndex={0}
            >
              <TriangleAlert className="size-3.5" aria-hidden />
            </span>
          </TooltipTrigger>
          <TooltipContent>{warnings.join(" · ")}</TooltipContent>
        </Tooltip>
      ) : null}
    </div>
  );
}

function compareText(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}
