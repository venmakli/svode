import {
  compareStandardPropertyValues,
  createDefaultStandardPropertyFilterRule,
  isEmptyValue,
  matchesStandardPropertyFilter,
  standardPropertyFilterOperators,
  validateStandardPropertyFilterRule,
  type CollectionPropertyDefinition,
} from "@/features/properties";

import type {
  CollectionFilterRule,
  CollectionPresentationDescriptor,
  CollectionQueryState,
  CollectionQueryValidationIssue,
  CollectionQueryValidationResult,
  CollectionSortDescriptor,
} from "./types";

export const EMPTY_COLLECTION_QUERY: CollectionQueryState = Object.freeze({
  filters: Object.freeze([]),
  search: "",
  sort: Object.freeze([]),
});

export function normalizeCollectionSearchText(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/gu, " ").toLowerCase();
}

export function collectionFilterOperators<Row>(
  property: CollectionPropertyDefinition<Row>,
): readonly string[] {
  const filter = property.capabilities?.filter;
  if (!filter) return [];
  return filter.kind === "standard"
    ? standardPropertyFilterOperators(property)
    : filter.operators;
}

export function createDefaultCollectionFilterRule<Row>(
  property: CollectionPropertyDefinition<Row>,
): CollectionFilterRule | null {
  const filter = property.capabilities?.filter;
  if (!filter) return null;
  const rule =
    filter.kind === "standard"
      ? createDefaultStandardPropertyFilterRule(property)
      : filter.operators[0]
        ? { operator: filter.operators[0] }
        : null;
  return rule ? { ...rule, propertyKey: property.key } : null;
}

export function validateCollectionQuery<Row>(
  descriptor: CollectionPresentationDescriptor<Row>,
  query: CollectionQueryState,
): CollectionQueryValidationResult {
  const issues: CollectionQueryValidationIssue[] = [];
  const filters: CollectionFilterRule[] = [];
  const sort: CollectionSortDescriptor[] = [];
  let search = query.search;

  if (!descriptor.query.getSearchText && search !== "") {
    search = "";
    issues.push({ reason: "search-unavailable" });
  }

  for (const rule of query.filters) {
    const property = descriptor.properties.find(
      (candidate) => candidate.key === rule.propertyKey,
    );
    if (!property) {
      issues.push({
        propertyKey: rule.propertyKey,
        reason: "unknown-property",
      });
      continue;
    }
    const filter = property.capabilities?.filter;
    if (!filter) {
      issues.push({
        propertyKey: rule.propertyKey,
        reason: "unsupported-filter",
      });
      continue;
    }
    if (!collectionFilterOperators(property).includes(rule.operator)) {
      issues.push({
        operator: rule.operator,
        propertyKey: rule.propertyKey,
        reason: "invalid-operator",
      });
      continue;
    }
    const valueValid =
      filter.kind === "standard"
        ? validateStandardPropertyFilterRule(property, rule)
        : safelyValidateCustomFilter(filter.validate, rule);
    if (!valueValid) {
      issues.push({
        operator: rule.operator,
        propertyKey: rule.propertyKey,
        reason: "invalid-value",
      });
      continue;
    }
    filters.push(rule);
  }

  for (const item of query.sort) {
    const property = descriptor.properties.find(
      (candidate) => candidate.key === item.propertyKey,
    );
    if (!property) {
      issues.push({
        propertyKey: item.propertyKey,
        reason: "unknown-property",
      });
      continue;
    }
    const sortSemantics = property.capabilities?.sort;
    if (!sortSemantics) {
      issues.push({
        propertyKey: item.propertyKey,
        reason: "unsupported-sort",
      });
      continue;
    }
    if (
      sortSemantics.kind === "standard" &&
      property.semantics.kind !== "standard"
    ) {
      issues.push({
        propertyKey: item.propertyKey,
        reason: "unsupported-sort",
      });
      continue;
    }
    sort.push(item);
  }

  const reset = issues.length > 0;
  return {
    issues,
    query: reset ? { filters, search, sort } : query,
    reset,
  };
}

export function isCollectionFilterDraftValid<Row>(
  descriptor: CollectionPresentationDescriptor<Row>,
  query: CollectionQueryState,
  draft: { index: number | null; item: CollectionFilterRule } | null,
): boolean {
  if (!draft) return false;
  if (
    draft.index !== null &&
    (draft.index < 0 || draft.index >= query.filters.length)
  ) {
    return false;
  }
  const filters = [...query.filters];
  if (draft.index === null) filters.push(draft.item);
  else filters[draft.index] = draft.item;
  const result = validateCollectionQuery(descriptor, { ...query, filters });
  return result.query.filters.includes(draft.item);
}

export function applyCollectionQuery<Row>({
  descriptor,
  query,
  rows,
}: {
  descriptor: CollectionPresentationDescriptor<Row>;
  query: CollectionQueryState;
  rows: readonly Row[];
}): {
  query: CollectionQueryState;
  reset: boolean;
  rows: readonly Row[];
  sourceRows: readonly Row[];
} {
  const validation = validateCollectionQuery(descriptor, query);
  const sourceRows = descriptor.query.fixedPredicate
    ? rows.filter(descriptor.query.fixedPredicate)
    : rows;
  const search = normalizeCollectionSearchText(validation.query.search);
  let result = search
    ? sourceRows.filter((row) =>
        normalizeCollectionSearchText(
          descriptor.query.getSearchText?.(row) ?? "",
        ).includes(search),
      )
    : [...sourceRows];

  for (const rule of validation.query.filters) {
    const property = descriptor.properties.find(
      (candidate) => candidate.key === rule.propertyKey,
    );
    const filter = property?.capabilities?.filter;
    if (!property || !filter) continue;
    result = result.filter((row) =>
      filter.kind === "standard"
        ? matchesStandardPropertyFilter(property, row, rule)
        : safelyMatchCustomFilter(filter.matches, row, rule),
    );
  }

  const ordering =
    validation.query.sort.length > 0
      ? validation.query.sort
      : descriptor.query.defaultSort;
  if (ordering?.length) {
    result.sort((left, right) =>
      compareRowsByFields(descriptor, ordering, left, right),
    );
  } else if (descriptor.query.defaultCompare) {
    result.sort((left, right) => {
      const compared = finiteComparison(
        descriptor.query.defaultCompare!(left, right),
      );
      return compared || compareRowIds(descriptor, left, right);
    });
  }

  return {
    query: validation.query,
    reset: validation.reset,
    rows: result,
    sourceRows,
  };
}

function safelyValidateCustomFilter(
  validate: (rule: CollectionFilterRule) => boolean,
  rule: CollectionFilterRule,
): boolean {
  try {
    return validate(rule);
  } catch {
    return false;
  }
}

function safelyMatchCustomFilter<Row>(
  matches: (row: Row, rule: CollectionFilterRule) => boolean,
  row: Row,
  rule: CollectionFilterRule,
): boolean {
  try {
    return matches(row, rule);
  } catch {
    return false;
  }
}

function compareRowsByFields<Row>(
  descriptor: CollectionPresentationDescriptor<Row>,
  ordering: readonly CollectionSortDescriptor[],
  left: Row,
  right: Row,
): number {
  for (const item of ordering) {
    const property = descriptor.properties.find(
      (candidate) => candidate.key === item.propertyKey,
    );
    const sort = property?.capabilities?.sort;
    if (!property || !sort) continue;

    let compared: number;
    if (sort.kind === "standard") {
      compared = compareStandardPropertyValues(
        property,
        property.getValue(left),
        property.getValue(right),
        item.direction,
      );
    } else {
      const leftValue = property.getValue(left);
      const rightValue = property.getValue(right);
      const emptyOrder = compareEmptyValues(leftValue, rightValue);
      compared = emptyOrder
        ? emptyOrder
        : isEmptyValue(leftValue)
          ? 0
          : directionMultiplier(item.direction) *
            finiteComparison(sort.compare(left, right));
    }
    if (compared !== 0) return compared;
  }
  return compareRowIds(descriptor, left, right);
}

function compareEmptyValues(left: unknown, right: unknown): number {
  const leftEmpty = isEmptyValue(left);
  const rightEmpty = isEmptyValue(right);
  return leftEmpty === rightEmpty ? 0 : leftEmpty ? 1 : -1;
}

function finiteComparison(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

function directionMultiplier(
  direction: CollectionSortDescriptor["direction"],
): number {
  return direction === "desc" ? -1 : 1;
}

function compareRowIds<Row>(
  descriptor: CollectionPresentationDescriptor<Row>,
  left: Row,
  right: Row,
): number {
  return compareCodeUnits(
    descriptor.getRowId(left),
    descriptor.getRowId(right),
  );
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
