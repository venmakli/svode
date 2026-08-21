import { Expand, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type {
  KnowledgeGraphFilters,
  KnowledgeScope,
  KnowledgeSpaceOption,
} from "../model/types";
import { KnowledgeFilters } from "./knowledge-filters";
import * as m from "@/paraglide/messages.js";

const PROJECT_SCOPE_VALUE = "project";
const ROOT_SCOPE_VALUE = "space:root";

export function KnowledgeToolbar({
  scope,
  filters,
  spaces,
  onScopeChange,
  onFiltersChange,
  onReset,
  onExpand,
}: {
  scope: KnowledgeScope;
  filters: KnowledgeGraphFilters;
  spaces: KnowledgeSpaceOption[];
  onScopeChange: (scope: KnowledgeScope) => void;
  onFiltersChange: (filters: KnowledgeGraphFilters) => void;
  onReset: () => void;
  onExpand?: () => void;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <KnowledgeScopeControls
        scope={scope}
        filters={filters}
        spaces={spaces}
        onScopeChange={onScopeChange}
        onFiltersChange={onFiltersChange}
      />
      <KnowledgeGraphResetButton onReset={onReset} />
      {onExpand && <KnowledgeOpenGraphButton onOpen={onExpand} />}
    </div>
  );
}

export function KnowledgeScopeControls({
  scope,
  filters,
  spaces,
  onScopeChange,
  onFiltersChange,
}: {
  scope: KnowledgeScope;
  filters: KnowledgeGraphFilters;
  spaces: KnowledgeSpaceOption[];
  onScopeChange: (scope: KnowledgeScope) => void;
  onFiltersChange: (filters: KnowledgeGraphFilters) => void;
}) {
  const value = scopeValue(scope);
  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <Select
        value={value}
        onValueChange={(nextValue) => onScopeChange(parseScope(nextValue))}
      >
        <SelectTrigger
          size="sm"
          aria-label={m.knowledge_graph_space_filter()}
          className="max-w-44"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent align="end">
          <SelectGroup>
            <SelectItem value={PROJECT_SCOPE_VALUE}>
              {m.knowledge_graph_project_scope()}
            </SelectItem>
            {spaces.map((space) => (
              <SelectItem
                key={space.id ?? ROOT_SCOPE_VALUE}
                value={space.id ? `space:${space.id}` : ROOT_SCOPE_VALUE}
              >
                {space.name}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
      <KnowledgeFilters filters={filters} onChange={onFiltersChange} />
    </div>
  );
}

export function KnowledgeGraphResetButton({
  onReset,
  variant = "ghost",
}: {
  onReset: () => void;
  variant?: "ghost" | "outline";
}) {
  return (
    <Button
      type="button"
      variant={variant}
      size="icon-sm"
      aria-label={m.knowledge_graph_reset()}
      title={m.knowledge_graph_reset()}
      onClick={onReset}
    >
      <RotateCcw />
    </Button>
  );
}

export function KnowledgeOpenGraphButton({ onOpen }: { onOpen: () => void }) {
  return (
    <Button type="button" variant="outline" size="sm" onClick={onOpen}>
      <Expand data-icon="inline-start" />
      {m.knowledge_graph_open()}
    </Button>
  );
}

function scopeValue(scope: KnowledgeScope) {
  if (scope.kind === "project") return PROJECT_SCOPE_VALUE;
  return scope.spaceId ? `space:${scope.spaceId}` : ROOT_SCOPE_VALUE;
}

function parseScope(value: string): KnowledgeScope {
  if (value === PROJECT_SCOPE_VALUE) return { kind: "project" };
  if (value === ROOT_SCOPE_VALUE) return { kind: "space", spaceId: null };
  return { kind: "space", spaceId: value.slice("space:".length) };
}
