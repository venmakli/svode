import { applyCollectionQuery } from "./query";
import type {
  CollectionPresentationDescriptor,
  CollectionQueryState,
} from "./types";

export interface CollectionVisibleRow<Row> {
  row: Row;
  ancestors: readonly string[];
}

export function collectionVisibleRows<Row>(
  descriptor: CollectionPresentationDescriptor<Row>,
  roots: readonly Row[],
  query: CollectionQueryState,
): CollectionVisibleRow<Row>[] {
  const hierarchy =
    descriptor.layout.kind === "table"
      ? descriptor.layout.hierarchy
      : undefined;
  const result: CollectionVisibleRow<Row>[] = [];
  const visit = (rows: readonly Row[], ancestors: readonly string[]) => {
    for (const row of rows) {
      const id = descriptor.getRowId(row);
      if (ancestors.includes(id)) continue;
      result.push({ row, ancestors });
      const branch = hierarchy?.getBranch(row);
      if (branch?.expanded) {
        const children = applyCollectionQuery({
          descriptor,
          rows: branch.rows,
          query: { ...query, search: "", filters: [] },
        }).rows;
        visit(children, [...ancestors, id]);
      }
    }
  };
  visit(roots, []);
  return result;
}
