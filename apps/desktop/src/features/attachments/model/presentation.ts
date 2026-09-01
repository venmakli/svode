import type {
  CollectionActivationContext,
  CollectionPresentationDescriptor,
  CollectionPresentationState,
} from "@/features/collection";
import {
  defineComputedCollectionProperty,
  type CollectionPropertyDefinition,
} from "@/features/properties";
import * as m from "@/paraglide/messages.js";

import type { AttachmentRow, AttachmentsSourceState } from "./types";

export const ATTACHMENTS_PRESENTATION_ID = "all";

export function createAttachmentsPresentationDescriptor({
  onActivate,
}: {
  onActivate(
    row: AttachmentRow,
    context: CollectionActivationContext,
  ): void | Promise<void>;
}): CollectionPresentationDescriptor<AttachmentRow> {
  const properties: readonly CollectionPropertyDefinition<AttachmentRow>[] = [
    defineComputedCollectionProperty({
      capabilities: {
        sort: { kind: "standard" },
      },
      featureId: "attachments",
      getValue: (row) => row.displayName,
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
      getValue: (row) => attachmentKindLabel(row.kind),
      key: "type",
      label: m.attachments_property_type(),
      standard: {
        options: [
          { color: "blue", name: m.attachments_type_page() },
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
      getValue: (row) => row.modified,
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
        getValue: (row) => row.sizeBytes,
        key: "size",
        label: m.attachments_property_size(),
        standard: { display: "bytes", type: "number" },
      }),
      getApplicability: (row) =>
        row.kind === "page"
          ? { label: "—", status: "unavailable" }
          : { status: "applicable" },
    },
  ];

  return {
    getRowId: (row) => row.key,
    id: ATTACHMENTS_PRESENTATION_ID,
    label: m.attachments_presentation_all(),
    layout: {
      density: "compact",
      kind: "table",
      primaryProperty: "name",
      visibleProperties: ["name", "type", "modified", "size"],
    },
    onActivate,
    properties,
    query: {
      defaultSort: [{ direction: "asc", propertyKey: "name" }],
      getSearchText: (row) =>
        `${row.displayName} ${attachmentKindLabel(row.kind)}`,
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
): CollectionPresentationState<AttachmentRow> {
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
    rows: state.snapshot.rows,
    sourceEmpty: content.sourceEmpty,
  };
}

export function attachmentKindLabel(kind: AttachmentRow["kind"]) {
  if (kind === "page") return m.attachments_type_page();
  if (kind === "document") return m.attachments_type_document();
  return m.attachments_type_media();
}
import type { ReactNode } from "react";
