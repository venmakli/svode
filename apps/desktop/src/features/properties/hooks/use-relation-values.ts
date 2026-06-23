import { useMemo } from "react";
import { normalizeRelationValues } from "../lib/relation";
import type { Column } from "../model";

export function useRelationValues(column: Column, value: unknown) {
  return useMemo(() => normalizeRelationValues(column, value), [column, value]);
}
