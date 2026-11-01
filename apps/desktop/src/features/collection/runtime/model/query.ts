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

export function collectionFilterOperators<Item>(
  property: CollectionPropertyDefinition<Item>,
): readonly string[] {
  const filter = property.capabilities?.filter;
  if (!filter) return [];
  return filter.kind === "standard"
    ? standardPropertyFilterOperators(property)
    : filter.operators;
}

export function createDefaultCollectionFilterRule<Item>(
  property: CollectionPropertyDefinition<Item>,
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

export function validateCollectionQuery<Item>(
  descriptor: CollectionPresentationDescriptor<Item>,
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

export function isCollectionFilterDraftValid<Item>(
  descriptor: CollectionPresentationDescriptor<Item>,
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

export function applyCollectionQuery<Item>({
  descriptor,
  query,
  items,
}: {
  descriptor: CollectionPresentationDescriptor<Item>;
  query: CollectionQueryState;
  items: readonly Item[];
}): {
  query: CollectionQueryState;
  reset: boolean;
  items: readonly Item[];
  sourceItems: readonly Item[];
} {
  const validation = validateCollectionQuery(descriptor, query);
  const sourceItems = descriptor.query.fixedPredicate
    ? items.filter(descriptor.query.fixedPredicate)
    : items;
  const search = normalizeCollectionSearchText(validation.query.search);
  let result = search
    ? sourceItems.filter((item) =>
        normalizeCollectionSearchText(
          descriptor.query.getSearchText?.(item) ?? "",
        ).includes(search),
      )
    : [...sourceItems];

  for (const rule of validation.query.filters) {
    const property = descriptor.properties.find(
      (candidate) => candidate.key === rule.propertyKey,
    );
    const filter = property?.capabilities?.filter;
    if (!property || !filter) continue;
    result = result.filter((item) =>
      filter.kind === "standard"
        ? matchesStandardPropertyFilter(property, item, rule)
        : safelyMatchCustomFilter(filter.matches, item, rule),
    );
  }

  const ordering =
    validation.query.sort.length > 0
      ? validation.query.sort
      : descriptor.query.defaultSort;
  if (ordering?.length) {
    result.sort((left, right) =>
      compareItemsByFields(descriptor, ordering, left, right),
    );
  } else if (descriptor.query.defaultCompare) {
    result.sort((left, right) => {
      const compared = finiteComparison(
        descriptor.query.defaultCompare!(left, right),
      );
      return compared || compareItemIds(descriptor, left, right);
    });
  }

  return {
    query: validation.query,
    reset: validation.reset,
    items: result,
    sourceItems,
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

function safelyMatchCustomFilter<Item>(
  matches: (item: Item, rule: CollectionFilterRule) => boolean,
  item: Item,
  rule: CollectionFilterRule,
): boolean {
  try {
    return matches(item, rule);
  } catch {
    return false;
  }
}

function compareItemsByFields<Item>(
  descriptor: CollectionPresentationDescriptor<Item>,
  ordering: readonly CollectionSortDescriptor[],
  left: Item,
  right: Item,
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
  return compareItemIds(descriptor, left, right);
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

function compareItemIds<Item>(
  descriptor: CollectionPresentationDescriptor<Item>,
  left: Item,
  right: Item,
): number {
  return compareCodeUnits(
    descriptor.query.getSortTieBreakId?.(left) ?? descriptor.getItemId(left),
    descriptor.query.getSortTieBreakId?.(right) ?? descriptor.getItemId(right),
  );
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
