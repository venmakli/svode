import type { CollectionView } from "@/features/collection/query/model";
import type { Entry } from "@/features/entry";
import type {
  ActorCandidate,
  CollectionSchema,
  Column,
} from "@/features/properties";
import { actorDisplayName } from "@/features/properties";
import type { BoardColumnGroup } from "../model/board-types";
import { entryCollectionPath, isFolderEntry } from "./entry-tree";
import { groupKeyForValue, groupValue, noValueKey } from "./board-entry";
import * as m from "@/paraglide/messages.js";

const STATUS_GROUP_ORDER = { todo: 0, in_progress: 1, done: 2 };
const SYSTEM_CARD_FIELDS = new Set([
  "title",
  "icon",
  "description",
  "created",
  "updated",
]);

export {
  groupKeyForValue,
  groupValue,
  groupValueForKey,
  noValueKey,
  reorderEntryAround,
  updateEntryGroupValue,
} from "./board-entry";

export { isFolderEntry };

export function isGroupableColumn(column: Column | null | undefined) {
  return (
    column?.type === "select" ||
    column?.type === "status" ||
    (column?.type === "actor" && !column.multiple)
  );
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
  actors: ActorCandidate[],
) {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    const key = groupKeyForValue(groupValue(entry, groupColumn));
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  const noValue: BoardColumnGroup[] = counts.has(noValueKey())
    ? [{ key: noValueKey(), value: null, label: m.board_no_value() }]
    : [];

  if (groupColumn.type === "select" || groupColumn.type === "status") {
    const options = sortedOptions(groupColumn);
    const optionNames = new Set(options.map((option) => option.name));
    const invalid = Array.from(counts.keys())
      .filter((key) => key !== noValueKey() && !optionNames.has(key))
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

  const actorByEmail = new Map(actors.map((actor) => [actor.email, actor]));
  const seen = Array.from(counts.keys())
    .filter((key) => key !== noValueKey())
    .sort((a, b) =>
      actorLabel(a, actorByEmail.get(a)).localeCompare(
        actorLabel(b, actorByEmail.get(b)),
      ),
    );

  return [
    ...noValue,
    ...seen.map((email) => {
      const actor = actorByEmail.get(email) ?? null;
      return {
        key: email,
        value: email,
        label: actorLabel(email, actor),
        actor,
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

export function isNestedCollectionEntry(
  entry: Entry,
  nestedCollectionPaths: Set<string>,
) {
  return nestedCollectionPaths.has(entryCollectionPath(entry));
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

function actorLabel(email: string, actor?: ActorCandidate | null) {
  return actor ? actorDisplayName(actor) : email;
}
