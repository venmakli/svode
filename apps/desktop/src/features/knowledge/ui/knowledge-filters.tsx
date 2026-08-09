import { ListFilter } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Field,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field";
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  countHiddenKnowledgeKinds,
  KNOWLEDGE_EDGE_KINDS,
  KNOWLEDGE_NODE_KINDS,
  toggleKnowledgeEdgeKind,
  toggleKnowledgeNodeKind,
} from "../model/filters";
import type { KnowledgeGraphFilters } from "../model/types";
import {
  knowledgeEdgeKindLabel,
  knowledgeNodeKindLabel,
} from "./knowledge-kind";
import * as m from "@/paraglide/messages.js";

export function KnowledgeFilters({
  filters,
  onChange,
}: {
  filters: KnowledgeGraphFilters;
  onChange: (filters: KnowledgeGraphFilters) => void;
}) {
  const hiddenCount = countHiddenKnowledgeKinds(filters);

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant={hiddenCount > 0 ? "secondary" : "ghost"}
          size="icon-sm"
          className="relative"
          aria-label={m.knowledge_graph_filters()}
          title={m.knowledge_graph_filters()}
        >
          <ListFilter />
          {hiddenCount > 0 && (
            <span className="absolute -right-1 -top-1 flex size-4 items-center justify-center rounded-full bg-primary text-[10px] text-primary-foreground">
              {hiddenCount}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 gap-4">
        <PopoverHeader>
          <PopoverTitle>{m.knowledge_graph_filters()}</PopoverTitle>
          <PopoverDescription>
            {m.knowledge_graph_filters_description()}
          </PopoverDescription>
        </PopoverHeader>
        <FieldSet>
          <FieldLegend variant="label">
            {m.knowledge_graph_node_types()}
          </FieldLegend>
          <FieldGroup data-slot="checkbox-group" className="gap-2.5">
            {KNOWLEDGE_NODE_KINDS.map((kind) => (
              <KindCheckbox
                key={kind}
                id={`knowledge-node-${kind}`}
                label={knowledgeNodeKindLabel(kind)}
                checked={filters.nodeKinds.includes(kind)}
                onCheckedChange={(checked) =>
                  onChange(
                    toggleKnowledgeNodeKind(filters, kind, checked === true),
                  )
                }
              />
            ))}
          </FieldGroup>
        </FieldSet>
        <FieldSet>
          <FieldLegend variant="label">
            {m.knowledge_graph_edge_types()}
          </FieldLegend>
          <FieldGroup data-slot="checkbox-group" className="gap-2.5">
            {KNOWLEDGE_EDGE_KINDS.map((kind) => (
              <KindCheckbox
                key={kind}
                id={`knowledge-edge-${kind}`}
                label={knowledgeEdgeKindLabel(kind)}
                checked={filters.edgeKinds.includes(kind)}
                onCheckedChange={(checked) =>
                  onChange(
                    toggleKnowledgeEdgeKind(filters, kind, checked === true),
                  )
                }
              />
            ))}
          </FieldGroup>
        </FieldSet>
      </PopoverContent>
    </Popover>
  );
}

function KindCheckbox({
  id,
  label,
  checked,
  onCheckedChange,
}: {
  id: string;
  label: string;
  checked: boolean;
  onCheckedChange: (checked: boolean | "indeterminate") => void;
}) {
  return (
    <Field orientation="horizontal">
      <Checkbox id={id} checked={checked} onCheckedChange={onCheckedChange} />
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
    </Field>
  );
}
