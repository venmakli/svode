import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { ActorCandidate, CollectionSchema } from "@/features/properties";

import type { FilterOp, QueryFilter } from "../../query/model/types";
import { FilterEditor } from "../../query/ui/query-controls";
import { systemCollectionFilterOperators } from "../model/query";
import type {
  SystemCollectionFieldDescriptor,
  SystemCollectionFilterRule,
} from "../model/types";

interface SystemCollectionQueryFilterEditorProps<Row> {
  actors: ActorCandidate[];
  field: SystemCollectionFieldDescriptor<Row>;
  onChange(rule: SystemCollectionFilterRule): void;
  onRequestActors?: (allTime?: boolean) => Promise<ActorCandidate[]>;
  rule: SystemCollectionFilterRule;
}

export function SystemCollectionQueryFilterEditor<Row>({
  actors,
  field,
  onChange,
  onRequestActors,
  rule,
}: SystemCollectionQueryFilterEditorProps<Row>) {
  if (
    field.filter?.kind === "property" &&
    field.valueSemantics?.kind === "property"
  ) {
    const column = { ...field.valueSemantics.column, name: field.key };
    const schema: CollectionSchema = { columns: [column], views: [] };
    const filter: QueryFilter = {
      field: field.key,
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
            fieldKey: field.key,
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

  if (field.filter?.kind !== "custom") {
    return null;
  }
  const operators = systemCollectionFilterOperators(field);
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
      {field.filter.renderEditor({
        onChange,
        rule,
      })}
    </div>
  );
}
