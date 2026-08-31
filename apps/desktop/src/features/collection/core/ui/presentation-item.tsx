import { useCallback, useId, useMemo, useState } from "react";

import * as m from "@/paraglide/messages.js";

import {
  CollectionPresentationListRow,
  CollectionPresentationPropertyFlow,
  CollectionPresentationPropertyItem,
} from "../../ui/presentation-core";
import { CollectionPresentationGalleryCard } from "../../ui/presentation-gallery-card";
import { runCollectionCoreCallback } from "../lib/interaction";
import type {
  CollectionCoreInteractionError,
  CollectionCorePresentationDescriptor,
} from "../model/types";
import {
  CollectionCorePropertyControl,
  CollectionCorePropertyValue,
  CollectionCoreInlineDiagnostic,
} from "./property-renderers";
import {
  CollectionCoreRowActionsContextMenu,
  CollectionCoreRowActionsDropdownMenu,
} from "./row-actions";

interface CollectionCorePresentationItemProps {
  descriptor: CollectionCorePresentationDescriptor<unknown>;
  activationFocusFallback?(): HTMLElement | null;
  instanceKey: string;
  row: unknown;
  rowId: string;
  selected: boolean;
  tabIndex: number;
  onFocus(rowId: string): void;
  onInteractionError?(error: CollectionCoreInteractionError): void;
  onMoveFocus(rowId: string, key: string): void;
  registerRow(rowId: string, element: HTMLElement | null): void;
}

export function CollectionCorePresentationItem({
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
}: CollectionCorePresentationItemProps) {
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
      kind: Exclude<CollectionCoreInteractionError["kind"], "create">,
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
    const result = await runCollectionCoreCallback(async () => {
      const descriptorActions =
        rowActions.length > 0 ? (
          <CollectionCoreRowActionsDropdownMenu
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
    }, m.collection_core_callback_error());

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
          <CollectionCoreInlineDiagnostic
            message={m.collection_core_unknown_property({
              property: propertyKey,
            })}
          />
        );
      }
      return <CollectionCorePropertyValue property={property} row={row} />;
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
          <CollectionCoreInlineDiagnostic
            message={m.collection_core_unknown_property({
              property: propertyKey,
            })}
          />
        );
      }
      return (
        <CollectionCorePropertyControl
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
    <CollectionCoreRowActionsContextMenu
      actions={rowActions}
      row={row}
      onRejected={(targetId, message) =>
        reportError("action", targetId, message)
      }
    />
  );

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
        data-collection-core-row={rowId}
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
              <CollectionCoreInlineDiagnostic message={activationError} />
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
      data-collection-core-row={rowId}
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
          <CollectionCoreInlineDiagnostic message={activationError} />
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
