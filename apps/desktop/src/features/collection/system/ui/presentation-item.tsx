import { useCallback, useId, useMemo, useState } from "react";

import * as m from "@/paraglide/messages.js";

import {
  CollectionPresentationListRow,
  CollectionPresentationPropertyFlow,
  CollectionPresentationPropertyItem,
} from "../../ui/presentation-core";
import { CollectionPresentationGalleryCard } from "../../ui/presentation-gallery-card";
import {
  createSystemCollectionDetailRequest,
  runSystemCollectionCallback,
} from "../lib/interaction";
import type {
  SystemCollectionDetailController,
  SystemCollectionInteractionError,
  SystemCollectionPresentationDescriptor,
} from "../model/types";
import {
  SystemCollectionFieldControl,
  SystemCollectionFieldValue,
  SystemCollectionInlineDiagnostic,
} from "./field-renderers";
import {
  SystemCollectionRowActionsContextMenu,
  SystemCollectionRowActionsDropdownMenu,
} from "./row-actions";

interface SystemCollectionPresentationItemProps {
  descriptor: SystemCollectionPresentationDescriptor<unknown>;
  detailController?: SystemCollectionDetailController;
  detailFocusFallback?(): HTMLElement | null;
  instanceKey: string;
  row: unknown;
  rowId: string;
  selected: boolean;
  tabIndex: number;
  onFocus(rowId: string): void;
  onInteractionError?(error: SystemCollectionInteractionError): void;
  onMoveFocus(rowId: string, key: string): void;
  registerRow(rowId: string, element: HTMLElement | null): void;
}

export function SystemCollectionPresentationItem({
  descriptor,
  detailController,
  detailFocusFallback,
  instanceKey,
  row,
  rowId,
  selected,
  tabIndex,
  onFocus,
  onInteractionError,
  onMoveFocus,
  registerRow,
}: SystemCollectionPresentationItemProps) {
  const [detailError, setDetailError] = useState<string | null>(null);
  const focusTargetId = useId();
  const detailEnabled = Boolean(
    descriptor.createDetailRequest && detailController,
  );
  const rowActions = useMemo(
    () =>
      (descriptor.rowActions ?? []).filter((action) => {
        try {
          return action.isVisible?.(row) ?? true;
        } catch {
          return true;
        }
      }),
    [descriptor.rowActions, row],
  );

  const reportError = useCallback(
    (
      kind: Exclude<
        SystemCollectionInteractionError["kind"],
        "create" | "refresh"
      >,
      targetId: string | undefined,
      message: string,
    ) => {
      onInteractionError?.({
        instanceKey,
        kind,
        message,
        presentationId: descriptor.id,
        rowId,
        targetId,
      });
    },
    [descriptor.id, instanceKey, onInteractionError, rowId],
  );

  const openDetail = useCallback(async () => {
    if (!descriptor.createDetailRequest || !detailController) return;

    setDetailError(null);
    const result = await runSystemCollectionCallback(async () => {
      const request = createSystemCollectionDetailRequest({
        descriptor,
        instanceKey,
        row,
        rowId,
      });
      if (request) {
        const descriptorActions =
          rowActions.length > 0 ? (
            <SystemCollectionRowActionsDropdownMenu
              actions={rowActions}
              row={row}
              onRejected={(targetId, message) =>
                reportError("action", targetId, message)
              }
            />
          ) : null;
        await detailController.open(
          {
            ...request,
            headerActions:
              request.headerActions || descriptorActions ? (
                <>
                  {request.headerActions}
                  {descriptorActions}
                </>
              ) : undefined,
          },
          {
            fallbackFocus: () =>
              document.getElementById(focusTargetId) ??
              detailFocusFallback?.() ??
              null,
          },
        );
      }
    }, m.system_collection_callback_error());

    if (!result.ok && result.message) {
      setDetailError(result.message);
      reportError("detail", undefined, result.message);
    }
  }, [
    descriptor,
    detailController,
    detailFocusFallback,
    focusTargetId,
    instanceKey,
    reportError,
    row,
    rowActions,
    rowId,
  ]);

  const renderContext = {
    renderField: (fieldKey: string) => {
      const field = descriptor.fields.find(
        (candidate) => candidate.key === fieldKey,
      );
      if (!field) {
        return (
          <SystemCollectionInlineDiagnostic
            message={m.system_collection_unknown_field({ field: fieldKey })}
          />
        );
      }
      return <SystemCollectionFieldValue field={field} row={row} />;
    },
    renderFieldControl: (fieldKey: string) => {
      const field = descriptor.fields.find(
        (candidate) => candidate.key === fieldKey,
      );
      if (!field) {
        return (
          <SystemCollectionInlineDiagnostic
            message={m.system_collection_unknown_field({ field: fieldKey })}
          />
        );
      }
      return (
        <SystemCollectionFieldControl
          field={field}
          row={row}
          onRejected={(targetId, message) =>
            reportError("field", targetId, message)
          }
        />
      );
    },
  };
  const actionContextMenu = (
    <SystemCollectionRowActionsContextMenu
      actions={rowActions}
      row={row}
      onRejected={(targetId, message) =>
        reportError("action", targetId, message)
      }
    />
  );

  if (descriptor.layout.kind === "list") {
    const layout = descriptor.layout;
    const fields = layout.visibleFields.map((fieldKey) => (
      <CollectionPresentationPropertyItem key={fieldKey} className="max-w-44">
        {descriptor.fields.find((field) => field.key === fieldKey)?.edit
          ? renderContext.renderFieldControl(fieldKey)
          : renderContext.renderField(fieldKey)}
      </CollectionPresentationPropertyItem>
    ));

    return (
      <CollectionPresentationListRow
        rowRef={(element) => registerRow(rowId, element)}
        aria-current={selected || undefined}
        data-system-collection-detail={detailEnabled || undefined}
        data-system-collection-row={rowId}
        id={focusTargetId}
        contextMenu={rowActions.length > 0 ? actionContextMenu : undefined}
        density={layout.density ?? "comfortable"}
        identity={
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="truncate text-sm font-medium">
              {layout.getTitle(row)}
            </span>
            {layout.getDescription ? (
              <span className="truncate text-xs text-muted-foreground">
                {layout.getDescription(row)}
              </span>
            ) : null}
            {detailError ? (
              <SystemCollectionInlineDiagnostic message={detailError} />
            ) : null}
          </div>
        }
        leading={layout.renderLeading?.(row)}
        properties={
          fields.length > 0 ? (
            <CollectionPresentationPropertyFlow className="max-w-[46vw]">
              {fields}
            </CollectionPresentationPropertyFlow>
          ) : undefined
        }
        role="listitem"
        selected={selected}
        tabIndex={tabIndex}
        onFocusRow={() => onFocus(rowId)}
        onMoveFocus={(key) => onMoveFocus(rowId, key)}
        onOpen={detailEnabled ? () => void openDetail() : undefined}
      />
    );
  }

  const layout = descriptor.layout;
  const fields = layout.visibleFields.map((fieldKey) => (
    <CollectionPresentationPropertyItem key={fieldKey}>
      {descriptor.fields.find((field) => field.key === fieldKey)?.edit
        ? renderContext.renderFieldControl(fieldKey)
        : renderContext.renderField(fieldKey)}
    </CollectionPresentationPropertyItem>
  ));

  return (
    <CollectionPresentationGalleryCard
      cardRef={(element) => registerRow(rowId, element)}
      aria-current={selected || undefined}
      data-system-collection-detail={detailEnabled || undefined}
      data-system-collection-row={rowId}
      density={layout.density}
      id={focusTargetId}
      role="listitem"
      selected={selected}
      tabIndex={tabIndex}
      contextMenu={rowActions.length > 0 ? actionContextMenu : undefined}
      cover={layout.renderCover?.(row)}
      description={layout.getDescription?.(row)}
      diagnostic={
        detailError ? (
          <SystemCollectionInlineDiagnostic message={detailError} />
        ) : undefined
      }
      leading={layout.renderLeading?.(row)}
      overlays={layout.renderOverlays?.(row)}
      properties={
        fields.length > 0 ? (
          <CollectionPresentationPropertyFlow className="justify-start gap-1.5 overflow-visible">
            {fields}
          </CollectionPresentationPropertyFlow>
        ) : undefined
      }
      title={layout.getTitle(row)}
      onFocusCard={() => onFocus(rowId)}
      onMoveFocus={(key) => onMoveFocus(rowId, key)}
      onOpen={detailEnabled ? () => void openDetail() : undefined}
    />
  );
}
