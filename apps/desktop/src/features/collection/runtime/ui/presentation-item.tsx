import { useCallback, useId, useMemo, useState } from "react";

import { TableCell } from "@/components/ui/table";
import * as m from "@/paraglide/messages.js";

import {
  CollectionPresentationListRow,
  CollectionPresentationPropertyFlow,
  CollectionPresentationPropertyItem,
} from "../../ui/presentation-chrome";
import { CollectionPresentationGalleryCard } from "../../ui/presentation-gallery-card";
import { CollectionTableRow } from "../../ui/table/table-presentation";
import { runCollectionCallback } from "../lib/interaction";
import type {
  CollectionInteractionError,
  CollectionPresentationDescriptor,
} from "../model/types";
import {
  CollectionPropertyControl,
  CollectionPropertyValue,
  CollectionInlineDiagnostic,
} from "./property-renderers";
import {
  CollectionRowActionsContextMenu,
  CollectionRowActionsDropdownMenu,
} from "./row-actions";

interface CollectionPresentationItemProps {
  descriptor: CollectionPresentationDescriptor<unknown>;
  activationFocusFallback?(): HTMLElement | null;
  instanceKey: string;
  row: unknown;
  rowId: string;
  selected: boolean;
  tabIndex: number;
  onFocus(rowId: string): void;
  onInteractionError?(error: CollectionInteractionError): void;
  onMoveFocus(rowId: string, key: string): void;
  registerRow(rowId: string, element: HTMLElement | null): void;
}

export function CollectionPresentationItem({
  descriptor,
  activationFocusFallback,
  instanceKey,
  row,
  rowId,
  selected,
  tabIndex,
  onFocus,
  onInteractionError,
  onMoveFocus,
  registerRow,
}: CollectionPresentationItemProps) {
  const [activationError, setActivationError] = useState<string | null>(null);
  const focusTargetId = useId();
  const activationEnabled = Boolean(descriptor.onActivate);
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
      kind: Exclude<CollectionInteractionError["kind"], "create">,
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

  const activate = useCallback(async () => {
    if (!descriptor.onActivate) return;

    setActivationError(null);
    const result = await runCollectionCallback(async () => {
      const descriptorActions =
        rowActions.length > 0 ? (
          <CollectionRowActionsDropdownMenu
            actions={rowActions}
            row={row}
            onRejected={(targetId, message) =>
              reportError("action", targetId, message)
            }
          />
        ) : undefined;
      await descriptor.onActivate?.(row, {
        actions: descriptorActions,
        fallbackFocus: activationFocusFallback,
        returnFocus: () => document.getElementById(focusTargetId),
        rowId,
      });
    }, m.collection_callback_error());

    if (!result.ok && result.message) {
      setActivationError(result.message);
      reportError("activation", undefined, result.message);
    }
  }, [
    activationFocusFallback,
    descriptor,
    focusTargetId,
    reportError,
    row,
    rowActions,
    rowId,
  ]);

  const renderContext = {
    renderProperty: (propertyKey: string) => {
      const property = descriptor.properties.find(
        (candidate) => candidate.key === propertyKey,
      );
      if (!property) {
        return (
          <CollectionInlineDiagnostic
            message={m.collection_unknown_property({
              property: propertyKey,
            })}
          />
        );
      }
      return <CollectionPropertyValue property={property} row={row} />;
    },
    renderPropertyControl: (
      propertyKey: string,
      density: "default" | "compact",
    ) => {
      const property = descriptor.properties.find(
        (candidate) => candidate.key === propertyKey,
      );
      if (!property) {
        return (
          <CollectionInlineDiagnostic
            message={m.collection_unknown_property({
              property: propertyKey,
            })}
          />
        );
      }
      return (
        <CollectionPropertyControl
          density={density}
          property={property}
          row={row}
          onRejected={(targetId, message) =>
            reportError("property", targetId, message)
          }
        />
      );
    },
  };
  const actionContextMenu = (
    <CollectionRowActionsContextMenu
      actions={rowActions}
      row={row}
      onRejected={(targetId, message) =>
        reportError("action", targetId, message)
      }
    />
  );

  if (descriptor.layout.kind === "table") {
    const layout = descriptor.layout;
    return (
      <CollectionTableRow
        rowRef={(element) => registerRow(rowId, element)}
        aria-current={selected || undefined}
        data-collection-activatable={activationEnabled || undefined}
        data-collection-row={rowId}
        id={focusTargetId}
        className="group/row h-10 bg-background text-[13px] hover:bg-muted/40"
        selected={selected}
        tabIndex={tabIndex}
        onActivate={activationEnabled ? () => void activate() : undefined}
        onMoveFocus={(key) => onMoveFocus(rowId, key)}
        onSelect={() => onFocus(rowId)}
      >
        {layout.visibleProperties.map((propertyKey) => {
          const property = descriptor.properties.find(
            (candidate) => candidate.key === propertyKey,
          );
          const value = property?.capabilities?.edit
            ? renderContext.renderPropertyControl(
                propertyKey,
                layout.density === "compact" ? "compact" : "default",
              )
            : renderContext.renderProperty(propertyKey);
          const primaryActivator =
            propertyKey === layout.primaryProperty &&
            activationEnabled &&
            !property?.capabilities?.edit;
          return (
            <TableCell
              key={propertyKey}
              className={
                propertyKey === layout.primaryProperty
                  ? "min-w-52 border-r px-2 py-0 font-medium"
                  : "min-w-32 border-r px-2 py-0"
              }
            >
              {primaryActivator ? (
                <button
                  type="button"
                  className="flex h-7 w-full min-w-0 items-center rounded px-1 text-left hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  data-collection-interactive
                  data-collection-primary
                  onClick={(event) => {
                    event.stopPropagation();
                    onFocus(rowId);
                    void activate();
                  }}
                  onFocus={() => onFocus(rowId)}
                >
                  {value}
                </button>
              ) : (
                value
              )}
              {propertyKey === layout.primaryProperty && activationError ? (
                <CollectionInlineDiagnostic message={activationError} />
              ) : null}
            </TableCell>
          );
        })}
        {rowActions.length > 0 ? (
          <TableCell className="w-10 p-1 text-right">
            <CollectionRowActionsDropdownMenu
              actions={rowActions}
              row={row}
              onRejected={(targetId, message) =>
                reportError("action", targetId, message)
              }
            />
          </TableCell>
        ) : null}
      </CollectionTableRow>
    );
  }

  if (
    descriptor.layout.kind !== "list" &&
    descriptor.layout.kind !== "gallery"
  ) {
    return null;
  }

  if (descriptor.layout.kind === "list") {
    const layout = descriptor.layout;
    const properties = layout.visibleProperties.map((propertyKey) => (
      <CollectionPresentationPropertyItem
        key={propertyKey}
        className="max-w-44"
      >
        {descriptor.properties.find((property) => property.key === propertyKey)
          ?.capabilities?.edit
          ? renderContext.renderPropertyControl(
              propertyKey,
              layout.density === "compact" ? "compact" : "default",
            )
          : renderContext.renderProperty(propertyKey)}
      </CollectionPresentationPropertyItem>
    ));

    return (
      <CollectionPresentationListRow
        rowRef={(element) => registerRow(rowId, element)}
        aria-current={selected || undefined}
        data-collection-activatable={activationEnabled || undefined}
        data-collection-row={rowId}
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
            {activationError ? (
              <CollectionInlineDiagnostic message={activationError} />
            ) : null}
          </div>
        }
        leading={layout.renderLeading?.(row)}
        properties={
          properties.length > 0 ? (
            <CollectionPresentationPropertyFlow className="max-w-[46vw]">
              {properties}
            </CollectionPresentationPropertyFlow>
          ) : undefined
        }
        role="listitem"
        selected={selected}
        tabIndex={tabIndex}
        onFocusRow={() => onFocus(rowId)}
        onMoveFocus={(key) => onMoveFocus(rowId, key)}
        onOpen={activationEnabled ? () => void activate() : undefined}
      />
    );
  }

  const layout = descriptor.layout;
  const properties = layout.visibleProperties.map((propertyKey) => (
    <CollectionPresentationPropertyItem key={propertyKey}>
      {descriptor.properties.find((property) => property.key === propertyKey)
        ?.capabilities?.edit
        ? renderContext.renderPropertyControl(
            propertyKey,
            layout.density === "compact" ? "compact" : "default",
          )
        : renderContext.renderProperty(propertyKey)}
    </CollectionPresentationPropertyItem>
  ));

  return (
    <CollectionPresentationGalleryCard
      cardRef={(element) => registerRow(rowId, element)}
      aria-current={selected || undefined}
      data-collection-activatable={activationEnabled || undefined}
      data-collection-row={rowId}
      density={layout.density}
      id={focusTargetId}
      role="listitem"
      selected={selected}
      tabIndex={tabIndex}
      contextMenu={rowActions.length > 0 ? actionContextMenu : undefined}
      cover={layout.renderCover?.(row)}
      description={layout.getDescription?.(row)}
      diagnostic={
        activationError ? (
          <CollectionInlineDiagnostic message={activationError} />
        ) : undefined
      }
      leading={layout.renderLeading?.(row)}
      overlays={layout.renderOverlays?.(row)}
      properties={
        properties.length > 0 ? (
          <CollectionPresentationPropertyFlow className="justify-start gap-1.5 overflow-visible">
            {properties}
          </CollectionPresentationPropertyFlow>
        ) : undefined
      }
      title={layout.getTitle(row)}
      onFocusCard={() => onFocus(rowId)}
      onMoveFocus={(key) => onMoveFocus(rowId, key)}
      onOpen={activationEnabled ? () => void activate() : undefined}
    />
  );
}
