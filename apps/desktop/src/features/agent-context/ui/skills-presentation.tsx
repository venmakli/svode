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
  defineCollectionPresentation,
  normalizeCollectionSearchText,
  type CollectionPresentationDescriptor,
  type CollectionPresentationState,
} from "@/features/collection";
import type { CollectionDetailContent } from "@/features/collection/app-shell";
import {
  defineDomainSpecificCollectionProperty,
  type CollectionPropertyDefinition,
  type CollectionPropertyFilterEditorInput,
} from "@/features/properties";
import * as m from "@/paraglide/messages.js";

import { skillSourceFamilies, skillSourceLocations } from "../model/provenance";
import type {
  AgentContextSkillRow,
  AgentContextSourceFamily,
  AgentContextSourceLocation,
} from "../model/types";
import { AgentContextArtifactOpenWith } from "./artifact-open-with";
import {
  sourceFamilyLabel,
  sourceLinkKindLabel,
  sourceLocationLabel,
} from "./provenance-labels";
import {
  agentContextHealthProperty,
  agentContextHealthWarnings,
} from "./health-property";
import { AgentContextSkillDetail } from "./skill-detail";

export function createAgentContextSkillsPresentation({
  onActivate,
  state,
}: {
  onActivate?: CollectionPresentationDescriptor<AgentContextSkillRow>["onActivate"];
  state: CollectionPresentationState<AgentContextSkillRow>;
}) {
  const properties = createSkillProperties();

  return defineCollectionPresentation<AgentContextSkillRow>({
    descriptor: {
      onActivate,
      properties,
      getRowId: (row) => row.id,
      id: "skills",
      label: m.agent_context_skills(),
      layout: {
        cardSize: "medium",
        density: "compact",
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
        visibleProperties: ["source", "location"],
      },
      query: {
        defaultCompare: compareSkillsByDefault,
        getSearchText: (row) => `${row.name} ${row.description}`,
      },
    },
    state,
  });
}

export function createSkillDetailContent(
  row: AgentContextSkillRow,
): CollectionDetailContent {
  return {
    content: (
      <AgentContextSkillDetail properties={createSkillProperties()} row={row} />
    ),
    description: row.description,
    identity: { icon: <Sparkles />, name: row.name },
    openWith: (
      <AgentContextArtifactOpenWith
        canonicalArtifactPath={row.manifestPath}
        ownerRoot={row.ownerPath}
      />
    ),
    title: row.name,
  };
}

/** The properties of a skill for its gallery cards and its detail panel. */
function createSkillProperties(): readonly CollectionPropertyDefinition<AgentContextSkillRow>[] {
  return [
    multiValueField(
      "source",
      m.agent_context_source(),
      skillSourceFamilies,
      ["agents", "claude"] satisfies readonly AgentContextSourceFamily[],
      sourceFamilyLabel,
      m.agent_context_filter_source_placeholder(),
    ),
    multiValueField(
      "location",
      m.agent_context_location(),
      skillSourceLocations,
      ["space", "global"] satisfies readonly AgentContextSourceLocation[],
      sourceLocationLabel,
      m.agent_context_filter_location_placeholder(),
      (values) => values.filter((value) => value === "global"),
    ),
    agentContextHealthProperty<AgentContextSkillRow>(),
  ];
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
      normalizeCollectionSearchText(left.name),
      normalizeCollectionSearchText(right.name),
    ) || compareText(left.canonicalPath, right.canonicalPath)
  );
}

function multiValueField<Value extends string>(
  key: string,
  label: string,
  getValues: (row: AgentContextSkillRow) => readonly Value[],
  options: readonly Value[],
  getLabel: (value: Value) => string,
  placeholder: string,
  getVisibleValues: (values: readonly Value[]) => readonly Value[] = (values) =>
    values,
): CollectionPropertyDefinition<AgentContextSkillRow> {
  return defineDomainSpecificCollectionProperty({
    capabilities: {
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
    },
    featureId: "agent-context",
    getValue: getValues,
    key,
    label,
    render: (_value, row) =>
      valueBadges(getVisibleValues(getValues(row)), getLabel),
    // The detail names every value, not only the exceptional ones.
    renderDetail: (_value, row) => valueBadges(getValues(row), getLabel),
  });
}

function valueBadges<Value extends string>(
  values: readonly Value[],
  getLabel: (value: Value) => string,
) {
  return values.length > 0 ? (
    <div className="flex flex-wrap gap-1">
      {values.map((value) => (
        <Badge key={value} variant="outline">
          {getLabel(value)}
        </Badge>
      ))}
    </div>
  ) : null;
}

function SkillFilterEditor<Value extends string>({
  getLabel,
  onChange,
  options,
  placeholder,
  rule,
}: CollectionPropertyFilterEditorInput & {
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
  const linkedAliases = row.aliases.filter(
    (alias) => alias.linkKind !== "direct",
  );
  const warnings = agentContextHealthWarnings(row);
  if (linkedAliases.length === 0 && warnings.length === 0) return null;

  return (
    <div className="absolute right-2 top-2 z-10 flex items-center gap-1">
      {linkedAliases.length > 0 ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              className="inline-flex size-6 items-center justify-center rounded-md border bg-background/95 text-muted-foreground shadow-sm"
              aria-label={skillLinkTooltipText(row)}
              tabIndex={0}
            >
              <Link2 className="size-3.5" aria-hidden />
            </span>
          </TooltipTrigger>
          <TooltipContent className="flex max-w-sm flex-col items-start gap-1">
            <span className="font-medium">
              {m.agent_context_linked_sources()}
            </span>
            {linkedAliases.map((alias) => (
              <span
                key={`${alias.sourceFamily}:${alias.location}:${alias.linkKind}:${alias.discoveryPath}`}
                className="break-all"
              >
                {skillAliasLinkLabel(alias)}
              </span>
            ))}
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

function skillLinkTooltipText(row: AgentContextSkillRow) {
  return row.aliases
    .filter((alias) => alias.linkKind !== "direct")
    .map(skillAliasLinkLabel)
    .join("; ");
}

function skillAliasLinkLabel(alias: AgentContextSkillRow["aliases"][number]) {
  return `${sourceFamilyLabel(alias.sourceFamily)} · ${sourceLocationLabel(alias.location)} · ${sourceLinkKindLabel(alias.linkKind)}: ${alias.discoveryPath}`;
}

function compareText(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}
