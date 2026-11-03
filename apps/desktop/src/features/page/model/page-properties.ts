import {
  defineSchemaBackedCollectionProperty,
  type ActorCandidate,
  type CollectionPropertyDefinition,
  type CollectionPropertyEdit,
  type CollectionSchema,
} from "@/features/properties";

import type { Page } from "./types";

/**
 * The properties of a Collection of Pages that its schema declares, one per
 * column in schema order; the columns of the Collection and the property
 * panel of an item are built from them. `edit` is the owner's editing of a
 * value, absent where it is not edited.
 */
export function definePageSchemaProperties(
  schema: CollectionSchema,
  {
    actorCandidates,
    edit,
  }: {
    actorCandidates?: readonly ActorCandidate[];
    /** The owner's editing of a property; none where it is not edited. */
    edit?: (field: string) => CollectionPropertyEdit<Page> | undefined;
  } = {},
): CollectionPropertyDefinition<Page>[] {
  return schema.columns.map((column) => {
    const columnEdit =
      edit && column.type !== "unique_id" ? edit(column.name) : undefined;
    return defineSchemaBackedCollectionProperty({
      ...(actorCandidates ? { actorCandidates } : {}),
      // Nothing filters, sorts or edits a property of a newer Svode version;
      // a `unique_id` number is assigned, never typed.
      capabilities: column.newer
        ? {}
        : {
            ...(columnEdit ? { edit: columnEdit } : {}),
            filter: { kind: "standard" },
            sort: { kind: "standard" },
          },
      column,
      getAccessibilityLabel: (page: Page) =>
        `${column.name}: ${page.meta.title}`,
      getValue: (page: Page) => page.meta.extra[column.name],
    });
  });
}
