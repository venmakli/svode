import {
  useCallback,
  useId,
  useState,
  type KeyboardEvent,
  type MouseEvent,
} from "react";

import { CardContent } from "@/components/ui/card";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { cn } from "@/shared/lib/utils";
import * as m from "@/paraglide/messages.js";

import {
  CollectionPresentationListRow,
  CollectionPresentationPropertyFlow,
  CollectionPresentationPropertyItem,
  isCollectionPresentationInteractiveTarget,
} from "../../ui/presentation-core";
import { CollectionCardShell } from "../../ui/presentation-layout";
import {
  createSystemCollectionDetailRequest,
  runSystemCollectionCallback,
} from "../lib/interaction";
import type {
  SystemCollectionDetailController,
  SystemCollectionInteractionError,
  SystemCollectionPresentationDescriptor,
  SystemCollectionRowRenderContext,
} from "../model/types";
import {
  SystemCollectionFieldControl,
  SystemCollectionFieldValue,
  SystemCollectionInlineDiagnostic,
} from "./field-renderers";
import {
  SystemCollectionRowActionButton,
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
          (descriptor.rowActions?.length ?? 0) > 0 ? (
            <SystemCollectionRowActionsDropdownMenu
              actions={descriptor.rowActions ?? []}
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
    rowId,
  ]);

  const renderContext: SystemCollectionRowRenderContext = {
    openDetail: () => void openDetail(),
    renderAction: (actionId) => {
      const action = descriptor.rowActions?.find(
        (candidate) => candidate.id === actionId,
      );
      if (!action) {
        return (
          <SystemCollectionInlineDiagnostic
            message={m.system_collection_unknown_action({ action: actionId })}
          />
        );
      }
      return (
        <SystemCollectionRowActionButton
          action={action}
          row={row}
          onRejected={(targetId, message) =>
            reportError("action", targetId, message)
          }
        />
      );
    },
    renderField: (fieldKey) => {
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
    renderFieldControl: (fieldKey) => {
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
  const rowActions = descriptor.rowActions ?? [];
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

  const card = (
    <CollectionCardShell
      ref={(element) => registerRow(rowId, element)}
      aria-current={selected || undefined}
      data-system-collection-detail={detailEnabled || undefined}
      data-system-collection-row={rowId}
      id={focusTargetId}
      role="listitem"
      selected={selected}
      tabIndex={tabIndex}
      className={cn(detailEnabled && "cursor-pointer")}
      onClick={(event: MouseEvent<HTMLElement>) => {
        if (isCollectionPresentationInteractiveTarget(event)) return;
        event.currentTarget.focus();
        if (detailEnabled) void openDetail();
      }}
      onFocus={() => onFocus(rowId)}
      onKeyDown={(event: KeyboardEvent<HTMLElement>) => {
        if (isCollectionPresentationInteractiveTarget(event)) return;
        if (
          event.key === "ArrowUp" ||
          event.key === "ArrowDown" ||
          event.key === "ArrowLeft" ||
          event.key === "ArrowRight" ||
          event.key === "Home" ||
          event.key === "End"
        ) {
          event.preventDefault();
          onMoveFocus(rowId, event.key);
        } else if (
          detailEnabled &&
          (event.key === "Enter" || event.key === " ")
        ) {
          event.preventDefault();
          void openDetail();
        } else if (event.key === "Escape") {
          event.currentTarget.blur();
        }
      }}
    >
      <CardContent className="flex flex-1 flex-col gap-2 p-3">
        {descriptor.layout.renderCardContent(row, renderContext)}
        {detailError ? (
          <SystemCollectionInlineDiagnostic message={detailError} />
        ) : null}
      </CardContent>
    </CollectionCardShell>
  );

  if (rowActions.length === 0) return card;

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{card}</ContextMenuTrigger>
      <ContextMenuContent className="w-56">
        {actionContextMenu}
      </ContextMenuContent>
    </ContextMenu>
  );
}
