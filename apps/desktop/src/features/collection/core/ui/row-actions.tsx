import { useCallback, useState } from "react";
import { LoaderCircle, MoreHorizontal } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  ContextMenuGroup,
  ContextMenuItem,
} from "@/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import * as m from "@/paraglide/messages.js";

import { runCollectionCoreCallback } from "../lib/interaction";
import type {
  CollectionCoreActionState,
  CollectionCoreRowActionDescriptor,
} from "../model/types";

interface CollectionCoreRowActionProps {
  action: CollectionCoreRowActionDescriptor<unknown>;
  row: unknown;
  onRejected(actionId: string, message: string): void;
}

interface EffectiveActionState {
  disabled: boolean;
  message?: string;
  pending: boolean;
  status: CollectionCoreActionState["status"];
}

function readActionState(
  action: CollectionCoreRowActionDescriptor<unknown>,
  row: unknown,
): CollectionCoreActionState {
  try {
    return action.getState(row);
  } catch (error) {
    return {
      status: "error",
      message:
        error instanceof Error && error.message
          ? error.message
          : m.collection_core_callback_error(),
    };
  }
}

function readActionLabel(
  action: CollectionCoreRowActionDescriptor<unknown>,
  row: unknown,
) {
  try {
    return action.getLabel?.(row) ?? action.label;
  } catch {
    return action.label;
  }
}

function useCollectionCoreRowAction({
  action,
  row,
  onRejected,
}: CollectionCoreRowActionProps) {
  const [localPending, setLocalPending] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const ownerState = readActionState(action, row);
  const pending = localPending || ownerState.status === "pending";
  const message =
    localError ??
    (ownerState.status === "disabled"
      ? ownerState.reason
      : ownerState.status === "error"
        ? ownerState.message
        : undefined);

  const run = useCallback(async () => {
    if (pending || ownerState.status === "disabled") {
      return false;
    }

    setLocalPending(true);
    setLocalError(null);
    const result = await runCollectionCoreCallback(
      () => action.run(row),
      m.collection_core_callback_error(),
    );
    setLocalPending(false);

    if (!result.ok && result.message) {
      setLocalError(result.message);
      onRejected(action.id, result.message);
    }
    return result.ok;
  }, [action, onRejected, ownerState.status, pending, row]);

  const state: EffectiveActionState = {
    disabled: pending || ownerState.status === "disabled",
    message,
    pending,
    status: localError ? "error" : pending ? "pending" : ownerState.status,
  };

  return { run, state };
}

export function CollectionCoreRowActionButton(
  props: CollectionCoreRowActionProps,
) {
  const { action } = props;
  const { run, state } = useCollectionCoreRowAction(props);
  const label = readActionLabel(action, props.row);
  const button = (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      disabled={state.disabled}
      data-collection-core-interactive
      data-collection-core-action={action.id}
      data-collection-core-action-state={state.status}
      title={state.message}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation();
        void run();
      }}
    >
      {state.pending ? (
        <LoaderCircle data-icon="inline-start" className="animate-spin" />
      ) : null}
      {label}
    </Button>
  );

  if (!state.message) {
    return button;
  }

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex" data-collection-core-interactive>
            {button}
          </span>
        </TooltipTrigger>
        <TooltipContent>{state.message}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

function CollectionCoreRowActionDropdownItem(
  props: CollectionCoreRowActionProps & {
    onSuccess(): void;
  },
) {
  const { action, onSuccess } = props;
  const { run, state } = useCollectionCoreRowAction(props);
  const label = readActionLabel(action, props.row);

  return (
    <DropdownMenuItem
      disabled={state.disabled}
      data-collection-core-action={action.id}
      data-collection-core-action-state={state.status}
      title={state.message}
      onSelect={(event) => {
        event.preventDefault();
        void run().then((ok) => {
          if (ok) {
            onSuccess();
          }
        });
      }}
    >
      {state.pending ? (
        <LoaderCircle data-icon="inline-start" className="animate-spin" />
      ) : null}
      <span>{label}</span>
      {state.message ? (
        <span className="sr-only"> — {state.message}</span>
      ) : null}
    </DropdownMenuItem>
  );
}

function CollectionCoreRowActionContextItem(
  props: CollectionCoreRowActionProps,
) {
  const { action } = props;
  const { run, state } = useCollectionCoreRowAction(props);
  const label = readActionLabel(action, props.row);

  return (
    <ContextMenuItem
      disabled={state.disabled}
      data-collection-core-action={action.id}
      data-collection-core-action-state={state.status}
      title={state.message}
      aria-description={state.message}
      onSelect={(event) => {
        event.preventDefault();
        void run();
      }}
    >
      {state.pending ? (
        <LoaderCircle data-icon="inline-start" className="animate-spin" />
      ) : null}
      <span>{label}</span>
      {state.message ? (
        <span className="sr-only"> — {state.message}</span>
      ) : null}
    </ContextMenuItem>
  );
}

export function CollectionCoreRowActionsContextMenu({
  actions,
  row,
  onRejected,
}: {
  actions: readonly CollectionCoreRowActionDescriptor<unknown>[];
  row: unknown;
  onRejected(actionId: string, message: string): void;
}) {
  if (actions.length === 0) return null;

  return (
    <ContextMenuGroup>
      {actions.map((action) => (
        <CollectionCoreRowActionContextItem
          key={action.id}
          action={action}
          row={row}
          onRejected={onRejected}
        />
      ))}
    </ContextMenuGroup>
  );
}

export function CollectionCoreRowActionsDropdownMenu({
  actions,
  row,
  onRejected,
}: {
  actions: readonly CollectionCoreRowActionDescriptor<unknown>[];
  row: unknown;
  onRejected(actionId: string, message: string): void;
}) {
  const [open, setOpen] = useState(false);

  if (actions.length === 0) {
    return null;
  }

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={m.collection_core_row_actions()}
          data-collection-core-interactive
          className="shrink-0 text-muted-foreground"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
        >
          <MoreHorizontal />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuGroup>
          {actions.map((action) => (
            <CollectionCoreRowActionDropdownItem
              key={action.id}
              action={action}
              row={row}
              onRejected={onRejected}
              onSuccess={() => setOpen(false)}
            />
          ))}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
