import {
  useCallback,
  useState,
  type KeyboardEvent,
  type MouseEvent,
} from "react";

import { CardContent } from "@/components/ui/card";
import { cn } from "@/shared/lib/utils";
import * as m from "@/paraglide/messages.js";

import {
  CollectionCardShell,
  CollectionListRowShell,
} from "../../ui/presentation-layout";
import {
  createSystemCollectionDetailRequest,
  isSystemCollectionInteractiveTarget,
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
  SystemCollectionRowActionsMenu,
} from "./row-actions";

interface SystemCollectionPresentationItemProps {
  descriptor: SystemCollectionPresentationDescriptor<unknown>;
  detailController?: SystemCollectionDetailController;
  density: "compact" | "comfortable";
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

function isInteractiveEvent(
  event: MouseEvent<HTMLElement> | KeyboardEvent<HTMLElement>,
) {
  return isSystemCollectionInteractiveTarget(event.target, event.currentTarget);
}

export function SystemCollectionPresentationItem({
  descriptor,
  detailController,
  density,
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
  const detailEnabled = Boolean(
    descriptor.createDetailRequest && detailController,
  );

  const reportError = useCallback(
    (
      kind: SystemCollectionInteractionError["kind"],
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
    if (!descriptor.createDetailRequest || !detailController) {
      return;
    }

    setDetailError(null);
    const result = await runSystemCollectionCallback(async () => {
      const request = createSystemCollectionDetailRequest({
        descriptor,
        instanceKey,
        row,
        rowId,
      });
      if (request) {
        await detailController.open(request);
      }
    }, m.system_collection_callback_error());

    if (!result.ok && result.message) {
      setDetailError(result.message);
      reportError("detail", undefined, result.message);
    }
  }, [descriptor, detailController, instanceKey, reportError, row, rowId]);

  const renderContext: SystemCollectionRowRenderContext = {
    openDetail: () => {
      void openDetail();
    },
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

  const content = descriptor.renderRowContent(row, renderContext);
  const rowActions = descriptor.rowActions ?? [];
  const commonProps = {
    "aria-current": selected || undefined,
    "data-system-collection-detail": detailEnabled || undefined,
    "data-system-collection-row": rowId,
    onClick: (event: MouseEvent<HTMLElement>) => {
      if (isInteractiveEvent(event)) {
        return;
      }
      event.currentTarget.focus();
      onFocus(rowId);
      if (detailEnabled) {
        void openDetail();
      }
    },
    onFocus: () => onFocus(rowId),
    onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
      if (isInteractiveEvent(event)) {
        return;
      }
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
    },
    ref: (element: HTMLElement | null) => registerRow(rowId, element),
    role: "listitem" as const,
    tabIndex,
  };

  if (descriptor.renderer === "cards") {
    return (
      <CollectionCardShell
        {...commonProps}
        selected={selected}
        className={cn(detailEnabled && "cursor-pointer")}
      >
        {rowActions.length > 0 ? (
          <div className="absolute right-2 top-2">
            <SystemCollectionRowActionsMenu
              actions={rowActions}
              row={row}
              onRejected={(targetId, message) =>
                reportError("action", targetId, message)
              }
            />
          </div>
        ) : null}
        <CardContent
          className={cn(
            "flex flex-1 flex-col gap-2 p-3",
            rowActions.length > 0 && "pr-10",
          )}
        >
          {content}
          {detailError ? (
            <SystemCollectionInlineDiagnostic message={detailError} />
          ) : null}
        </CardContent>
      </CollectionCardShell>
    );
  }

  return (
    <CollectionListRowShell
      {...commonProps}
      density={density}
      selected={selected}
      className={cn(detailEnabled && "cursor-pointer")}
    >
      <span aria-hidden />
      <div className="flex min-w-0 flex-col gap-1">
        {content}
        {detailError ? (
          <SystemCollectionInlineDiagnostic message={detailError} />
        ) : null}
      </div>
      <SystemCollectionRowActionsMenu
        actions={rowActions}
        row={row}
        onRejected={(targetId, message) =>
          reportError("action", targetId, message)
        }
      />
    </CollectionListRowShell>
  );
}
