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
  const value = scopeValue(scope);
  return (
    <div className="flex items-center gap-1.5">
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
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={m.knowledge_graph_reset()}
        title={m.knowledge_graph_reset()}
        onClick={onReset}
      >
        <RotateCcw />
      </Button>
      {onExpand && (
        <Button type="button" variant="outline" size="sm" onClick={onExpand}>
          <Expand data-icon="inline-start" />
          {m.knowledge_graph_open()}
        </Button>
      )}
    </div>
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
