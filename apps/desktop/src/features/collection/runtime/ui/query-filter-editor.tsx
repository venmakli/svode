import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  resolveStandardPropertyColumn,
  type ActorCandidate,
  type CollectionPropertyDefinition,
  type CollectionSchema,
} from "@/features/properties";

import type { FilterOp, QueryFilter } from "../../query/model/types";
import { FilterEditor } from "../../query/ui/query-controls";
import { collectionFilterOperators } from "../model/query";
import type { CollectionFilterRule } from "../model/types";

interface CollectionQueryFilterEditorProps<Row> {
  actors: ActorCandidate[];
  property: CollectionPropertyDefinition<Row>;
  onChange(rule: CollectionFilterRule): void;
  onRequestActors?: (allTime?: boolean) => Promise<ActorCandidate[]>;
  rule: CollectionFilterRule;
}

export function CollectionQueryFilterEditor<Row>({
  actors,
  property,
  onChange,
  onRequestActors,
  rule,
}: CollectionQueryFilterEditorProps<Row>) {
  const filterSemantics = property.capabilities?.filter;
  const standardColumn = resolveStandardPropertyColumn(property);
  if (filterSemantics?.kind === "standard" && standardColumn) {
    const column = { ...standardColumn, name: property.key };
    const schema: CollectionSchema = { columns: [column], views: [] };
    const filter: QueryFilter = {
      field: property.key,
      op: rule.operator as FilterOp,
      value: rule.value,
      values: rule.values ? [...rule.values] : undefined,
    };
    return (
      <FilterEditor
        actors={actors}
        draft={filter}
        onChange={(next) =>
          onChange({
            propertyKey: property.key,
            operator: next.op,
            value: next.value,
            values: next.values,
          })
        }
        onRequestActors={onRequestActors}
        schema={schema}
      />
    );
  }

  if (filterSemantics?.kind !== "custom") {
    return null;
  }
  const operators = collectionFilterOperators(property);
  return (
    <div className="flex flex-col gap-3 p-3">
      <Select
        value={rule.operator}
        onValueChange={(operator) => onChange({ ...rule, operator })}
      >
        <SelectTrigger className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            {operators.map((operator) => (
              <SelectItem key={operator} value={operator}>
                {operator}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
      {filterSemantics.renderEditor({
        onChange: (next) => onChange({ ...rule, ...next }),
        rule: {
          operator: rule.operator,
          value: rule.value,
          values: rule.values,
        },
      })}
    </div>
  );
}
