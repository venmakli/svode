import type { Entry } from "@/features/editor/types";
import type {
  CollectionSchema,
  Column,
  Person,
} from "@/features/properties/types";
import { isEmptyValue, personDisplayName } from "@/features/properties/utils";
import type { CollectionView } from "@/features/collection-query/types";
import { entryCollectionPath } from "../table/utils";
import type { BoardColumnGroup } from "./types";
import * as m from "@/paraglide/messages.js";

const NO_VALUE_KEY = "__no_value__";
const STATUS_GROUP_ORDER = { todo: 0, in_progress: 1, done: 2 };
const SYSTEM_CARD_FIELDS = new Set([
  "title",
  "icon",
  "description",
  "created",
  "updated",
]);

export function noValueKey() {
  return NO_VALUE_KEY;
}

export function groupKeyForValue(value: unknown) {
  return isEmptyValue(value) ? NO_VALUE_KEY : String(value);
}

export function groupValueForKey(key: string) {
  return key === NO_VALUE_KEY ? null : key;
}

export function isGroupableColumn(column: Column | null | undefined) {
  return (
    column?.type === "select" ||
    column?.type === "status" ||
    column?.type === "person"
  );
}

export function groupValue(entry: Entry, column: Column) {
  return entry.meta.extra?.[column.name] ?? null;
}

export function normalizeBoardCardFields(
  view: CollectionView,
  schema: CollectionSchema,
) {
  const configured = Array.isArray(view.card_fields)
    ? (view.card_fields as unknown[]).map(String)
    : [
        "icon",
        "title",
        "description",
        ...schema.columns.slice(0, 4).map((column) => column.name),
      ];
  const allowed = new Set([
    "title",
    "icon",
    "description",
    ...schema.columns.map((column) => column.name),
  ]);
  const fields = configured.filter((field) => allowed.has(field));
  return fields.includes("title") ? fields : ["title", ...fields];
}

export function boardCustomFields(
  fields: string[],
  schema: CollectionSchema,
  groupBy: string,
) {
  return fields
    .filter((field) => !SYSTEM_CARD_FIELDS.has(field) && field !== groupBy)
    .map((field) => schema.columns.find((column) => column.name === field))
    .filter((column): column is Column => Boolean(column));
}

export function boardColumns(
  entries: Entry[],
  groupColumn: Column,
  persons: Person[],
) {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    const key = groupKeyForValue(groupValue(entry, groupColumn));
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  const noValue: BoardColumnGroup[] = counts.has(NO_VALUE_KEY)
    ? [{ key: NO_VALUE_KEY, value: null, label: m.board_no_value() }]
    : [];

  if (groupColumn.type === "select" || groupColumn.type === "status") {
    const options = sortedOptions(groupColumn);
    const optionNames = new Set(options.map((option) => option.name));
    const invalid = Array.from(counts.keys())
      .filter((key) => key !== NO_VALUE_KEY && !optionNames.has(key))
      .sort((a, b) => a.localeCompare(b));
    return [
      ...noValue,
      ...options.map((option) => ({
        key: option.name,
        value: option.name,
        label: option.name,
        option,
        collapsedByDefault:
          groupColumn.type === "status" && option.group === "done",
      })),
      ...invalid.map((key) => ({
        key,
        value: key,
        label: m.board_invalid_value({ value: key }),
      })),
    ];
  }

  const personByEmail = new Map(
    persons.map((person) => [person.email, person]),
  );
  const seen = Array.from(counts.keys())
    .filter((key) => key !== NO_VALUE_KEY)
    .sort((a, b) =>
      personLabel(a, personByEmail.get(a)).localeCompare(
        personLabel(b, personByEmail.get(b)),
      ),
    );

  return [
    ...noValue,
    ...seen.map((email) => {
      const person = personByEmail.get(email) ?? null;
      return {
        key: email,
        value: email,
        label: personLabel(email, person),
        person,
      };
    }),
  ];
}

export function entriesForGroup(
  entries: Entry[],
  column: Column,
  groupKey: string,
) {
  return entries.filter(
    (entry) => groupKeyForValue(groupValue(entry, column)) === groupKey,
  );
}

export function updateEntryGroupValue(
  entry: Entry,
  column: Column,
  value: string | null,
) {
  const extra = { ...entry.meta.extra };
  if (value === null) delete extra[column.name];
  else extra[column.name] = value;
  return {
    ...entry,
    meta: {
      ...entry.meta,
      extra,
    },
  };
}

export function reorderEntryAround(
  entries: Entry[],
  activePath: string,
  overPath: string,
  placement: "before" | "after",
) {
  if (activePath === overPath) return entries;
  const active = entries.find((entry) => entry.path === activePath);
  if (!active) return entries;
  const withoutActive = entries.filter((entry) => entry.path !== activePath);
  const insertAt = withoutActive.findIndex((entry) => entry.path === overPath);
  if (insertAt < 0) return entries;
  const offset = placement === "after" ? 1 : 0;
  return [
    ...withoutActive.slice(0, insertAt + offset),
    active,
    ...withoutActive.slice(insertAt + offset),
  ];
}

export function isNestedCollectionEntry(
  entry: Entry,
  nestedCollectionPaths: Set<string>,
) {
  return nestedCollectionPaths.has(entryCollectionPath(entry));
}

export function isFolderEntry(entry: Entry) {
  return entry.path.toLowerCase().endsWith("/readme.md");
}

function sortedOptions(column: Column) {
  const options = [...(column.options ?? [])];
  if (column.type !== "status") return options;
  return options.sort((a, b) => {
    const groupA = STATUS_GROUP_ORDER[a.group ?? "todo"] ?? 99;
    const groupB = STATUS_GROUP_ORDER[b.group ?? "todo"] ?? 99;
    if (groupA !== groupB) return groupA - groupB;
    return (
      (column.options ?? []).indexOf(a) - (column.options ?? []).indexOf(b)
    );
  });
}

function personLabel(email: string, person?: Person | null) {
  return person ? personDisplayName(person) : email;
}
