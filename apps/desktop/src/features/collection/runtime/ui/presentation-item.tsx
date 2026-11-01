import { useCallback, useId, useMemo, useState } from "react";

import { ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/shared/lib/utils";
import { TableCell } from "@/components/ui/table";
import {
  CollectionInlineDiagnostic,
  CollectionPropertyValue,
} from "@/features/properties/display";
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
import { CollectionPropertyControl } from "./property-renderers";
import {
  CollectionItemActionsContextMenu,
  CollectionItemActionsDropdownMenu,
  visibleItemActions,
} from "./item-actions";

interface CollectionPresentationItemProps {
  descriptor: CollectionPresentationDescriptor<unknown>;
  depth?: number;
  activationFocusFallback?(): HTMLElement | null;
  instanceKey: string;
  item: unknown;
  itemId: string;
  selected: boolean;
  tabIndex: number;
  onFocus(itemId: string): void;
  onInteractionError?(error: CollectionInteractionError): void;
  onMoveFocus(itemId: string, key: string): void;
  registerItem(itemId: string, element: HTMLElement | null): void;
}

export function CollectionPresentationItem({
  descriptor,
  depth = 0,
  activationFocusFallback,
  instanceKey,
  item,
  itemId,
  selected,
  tabIndex,
  onFocus,
  onInteractionError,
  onMoveFocus,
  registerItem,
}: CollectionPresentationItemProps) {
  const [activationError, setActivationError] = useState<string | null>(null);
  const focusTargetId = useId();
  const activationEnabled = Boolean(descriptor.onActivate);
  const itemActions = useMemo(
    () => visibleItemActions(descriptor.itemActions, item),
    [descriptor.itemActions, item],
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
        itemId,
        targetId,
      });
    },
    [descriptor.id, instanceKey, onInteractionError, itemId],
  );

  const activate = useCallback(async () => {
    if (!descriptor.onActivate) return;

    setActivationError(null);
    const result = await runCollectionCallback(async () => {
      await descriptor.onActivate?.(item, {
        fallbackFocus: activationFocusFallback,
        returnFocus: () => document.getElementById(focusTargetId),
        itemId,
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
    item,
    itemId,
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
      return <CollectionPropertyValue property={property} item={item} />;
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
          item={item}
          onRejected={(targetId, message) =>
            reportError("property", targetId, message)
          }
        />
      );
    },
  };
  const actionContextMenu = (
    <CollectionItemActionsContextMenu
      actions={itemActions}
      item={item}
      onRejected={(targetId, message) =>
        reportError("action", targetId, message)
      }
    />
  );

  if (descriptor.layout.kind === "table") {
    const layout = descriptor.layout;
    const branch = layout.hierarchy?.getBranch(item);
    return (
      <CollectionTableRow
        rowRef={(element) => registerItem(itemId, element)}
        aria-current={selected || undefined}
        data-collection-activatable={activationEnabled || undefined}
        data-collection-row={itemId}
        id={focusTargetId}
        className="group/row h-10 bg-background text-[13px] hover:bg-muted/40"
        selected={selected}
        tabIndex={tabIndex}
        onActivate={activationEnabled ? () => void activate() : undefined}
        onMoveFocus={(key) => onMoveFocus(itemId, key)}
        onSelect={() => onFocus(itemId)}
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
          const leading =
            propertyKey === layout.primaryProperty
              ? layout.renderLeading?.(item)
              : null;
          const primary = propertyKey === layout.primaryProperty;
          const content = (
            <span className="flex min-w-0 items-center gap-2">
              {!layout.hierarchy ? leading : null}
              <span className="min-w-0 truncate">{value}</span>
            </span>
          );
          const disclosure =
            primary && branch ? (
              <Button
                variant="ghost"
                size="icon-sm"
                className="group/disclosure relative shrink-0"
                data-collection-interactive
                aria-expanded={branch.expanded}
                aria-label={
                  branch.expanded
                    ? m.collection_collapse_row({
                        name: layout.hierarchy!.getLabel(item),
                      })
                    : m.collection_expand_row({
                        name: layout.hierarchy!.getLabel(item),
                      })
                }
                onClick={(event) => {
                  event.stopPropagation();
                  layout.hierarchy!.onToggle(item);
                }}
              >
                <span
                  className={cn(
                    "inline-flex",
                    branch.expanded
                      ? "invisible"
                      : "group-hover/row:invisible group-focus-within/disclosure:invisible",
                  )}
                >
                  {leading}
                </span>
                <ChevronRight
                  className={cn(
                    "absolute",
                    branch.expanded
                      ? "rotate-90"
                      : "invisible group-hover/row:visible group-focus-within/disclosure:visible",
                  )}
                />
              </Button>
            ) : primary && leading && layout.hierarchy ? (
              <span
                className="inline-flex shrink-0 items-center justify-center"
                style={{ width: layout.hierarchy ? 28 : 16 }}
              >
                {leading}
              </span>
            ) : null;
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
              <div
                className="flex min-w-0 items-center gap-1"
                style={
                  primary && layout.hierarchy
                    ? { paddingInlineStart: depth * 20 }
                    : undefined
                }
              >
                {disclosure}
                {primaryActivator ? (
                  <button
                    type="button"
                    className="flex h-7 w-full min-w-0 items-center rounded px-1 text-left hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    data-collection-interactive
                    data-collection-primary
                  >
                    {content}
                  </button>
                ) : (
                  content
                )}
              </div>
              {propertyKey === layout.primaryProperty && activationError ? (
                <CollectionInlineDiagnostic message={activationError} />
              ) : null}
            </TableCell>
          );
        })}
        {itemActions.length > 0 ? (
          <TableCell className="w-10 p-1 text-right">
            <CollectionItemActionsDropdownMenu
              actions={itemActions}
              item={item}
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
        rowRef={(element) => registerItem(itemId, element)}
        aria-current={selected || undefined}
        data-collection-activatable={activationEnabled || undefined}
        data-collection-row={itemId}
        id={focusTargetId}
        contextMenu={itemActions.length > 0 ? actionContextMenu : undefined}
        density={layout.density ?? "comfortable"}
        identity={
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="truncate text-sm font-medium">
              {layout.getTitle(item)}
            </span>
            {layout.getDescription ? (
              <span className="truncate text-xs text-muted-foreground">
                {layout.getDescription(item)}
              </span>
            ) : null}
            {activationError ? (
              <CollectionInlineDiagnostic message={activationError} />
            ) : null}
          </div>
        }
        leading={layout.renderLeading?.(item)}
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
        onFocusRow={() => onFocus(itemId)}
        onMoveFocus={(key) => onMoveFocus(itemId, key)}
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
      cardRef={(element) => registerItem(itemId, element)}
      aria-current={selected || undefined}
      data-collection-activatable={activationEnabled || undefined}
      data-collection-row={itemId}
      density={layout.density}
      id={focusTargetId}
      role="listitem"
      selected={selected}
      tabIndex={tabIndex}
      contextMenu={itemActions.length > 0 ? actionContextMenu : undefined}
      cover={layout.renderCover?.(item)}
      description={layout.getDescription?.(item)}
      diagnostic={
        activationError ? (
          <CollectionInlineDiagnostic message={activationError} />
        ) : undefined
      }
      leading={layout.renderLeading?.(item)}
      overlays={layout.renderOverlays?.(item)}
      properties={
        properties.length > 0 ? (
          <CollectionPresentationPropertyFlow className="justify-start gap-1.5 overflow-visible">
            {properties}
          </CollectionPresentationPropertyFlow>
        ) : undefined
      }
      title={layout.getTitle(item)}
      onFocusCard={() => onFocus(itemId)}
      onMoveFocus={(key) => onMoveFocus(itemId, key)}
      onOpen={activationEnabled ? () => void activate() : undefined}
    />
  );
}
