import { getDirectoryPresentationKind } from "@/features/artifact";
import type {
  CollectionActivationContext,
  CollectionCreateCapability,
  CollectionPresentationDescriptor,
  CollectionPresentationState,
} from "@/features/collection";
import {
  defineComputedCollectionProperty,
  type CollectionPropertyDefinition,
} from "@/features/properties";
import * as m from "@/paraglide/messages.js";

import type { AttachmentItem, AttachmentsSourceState } from "./types";

export const ATTACHMENTS_PRESENTATION_ID = "all";

export function createAttachmentsPresentationDescriptor({
  create,
  onActivate,
  renderLeading,
  hierarchy,
}: {
  hierarchy?: Extract<
    CollectionPresentationDescriptor<AttachmentItem>["layout"],
    { kind: "table" }
  >["hierarchy"];
  renderLeading?: (item: AttachmentItem) => ReactNode;
  create?: CollectionCreateCapability;
  onActivate(
    item: AttachmentItem,
    context: CollectionActivationContext,
  ): void | Promise<void>;
}): CollectionPresentationDescriptor<AttachmentItem> {
  const properties: readonly CollectionPropertyDefinition<AttachmentItem>[] = [
    defineComputedCollectionProperty({
      capabilities: {
        filter: { kind: "standard" },
        sort: { kind: "standard" },
      },
      featureId: "attachments",
      getValue: (item) => item.displayName,
      key: "name",
      label: m.attachments_property_name(),
      standard: { type: "text" },
    }),
    defineComputedCollectionProperty({
      capabilities: {
        filter: { kind: "standard" },
        sort: { kind: "standard" },
      },
      featureId: "attachments",
      getValue: (item) => attachmentKindLabel(item),
      key: "type",
      label: m.attachments_property_type(),
      standard: {
        options: [
          { color: "blue", name: m.attachments_type_page() },
          { color: "purple", name: m.attachments_type_collection() },
          { color: "green", name: m.attachments_type_app() },
          { color: "gray", name: m.attachments_type_folder() },
          { color: "purple", name: m.attachments_type_document() },
          { color: "orange", name: m.attachments_type_media() },
        ],
        type: "select",
      },
    }),
    defineComputedCollectionProperty({
      capabilities: {
        filter: { kind: "standard" },
        sort: { kind: "standard" },
      },
      featureId: "attachments",
      getValue: (item) => item.modified,
      key: "modified",
      label: m.attachments_property_modified(),
      standard: { display: "medium", type: "date" },
    }),
    {
      ...defineComputedCollectionProperty({
        capabilities: {
          filter: { kind: "standard" },
          sort: { kind: "standard" },
        },
        featureId: "attachments",
        getValue: (item) => item.sizeBytes,
        key: "size",
        label: m.attachments_property_size(),
        standard: { display: "bytes", type: "number" },
      }),
      getApplicability: (item) =>
        item.kind === "document" || item.kind === "media"
          ? { status: "applicable" }
          : { label: "—", status: "unavailable" },
    },
  ];

  return {
    create,
    getItemId: (item) => item.key,
    id: ATTACHMENTS_PRESENTATION_ID,
    label: m.attachments_presentation_all(),
    layout: {
      density: "compact",
      kind: "table",
      primaryProperty: "name",
      hierarchy,
      ...(renderLeading ? { renderLeading } : {}),
      visibleProperties: ["name", "type", "modified", "size"],
    },
    onActivate,
    properties,
    query: {
      getSortTieBreakId: (item) => item.path,
      defaultSort: [{ direction: "asc", propertyKey: "name" }],
      getSearchText: (item) =>
        `${item.displayName} ${attachmentKindLabel(item)}`,
    },
  };
}

export function attachmentsPresentationState(
  state: AttachmentsSourceState,
  content: {
    blockingError: ReactNode;
    diagnostic?: ReactNode;
    sourceEmpty: ReactNode;
  },
): CollectionPresentationState<AttachmentItem> {
  if (state.phase === "initial") return { phase: "initial" };
  if (state.phase === "blocking_error") {
    return { error: content.blockingError, phase: "blocking_error" };
  }
  const diagnostics = [
    ...(content.diagnostic ? [content.diagnostic] : []),
    ...state.snapshot.diagnostics.map((diagnostic) =>
      m.attachments_source_partial({ path: diagnostic.path }),
    ),
  ];
  return {
    diagnostics,
    phase: "ready",
    items: state.snapshot.items,
    sourceEmpty: content.sourceEmpty,
  };
}

export function attachmentPresentationKind(item: AttachmentItem) {
  if (item.kind === "document" || item.kind === "media") return item.kind;
  return getDirectoryPresentationKind({
    hasSchema: item.kind === "collection",
    hasApp: item.hasApp || item.kind === "app",
    hasPage: item.kind === "page",
  });
}

export function attachmentKindLabel(item: AttachmentItem) {
  const kind = attachmentPresentationKind(item);
  if (kind === "directory") return m.attachments_type_folder();
  if (kind === "page") return m.attachments_type_page();
  if (kind === "document") return m.attachments_type_document();
  if (kind === "media") return m.attachments_type_media();
  if (kind === "collection") return m.attachments_type_collection();
  return m.attachments_type_app();
}
import type { ReactNode } from "react";
