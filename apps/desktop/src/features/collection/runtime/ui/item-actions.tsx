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

import { runCollectionCallback } from "../lib/interaction";
import type {
  CollectionActionState,
  CollectionItemActionDescriptor,
} from "../model/types";

interface CollectionItemActionProps {
  action: CollectionItemActionDescriptor<unknown>;
  item: unknown;
  onRejected(actionId: string, message: string): void;
}

interface EffectiveActionState {
  disabled: boolean;
  message?: string;
  pending: boolean;
  status: CollectionActionState["status"];
}

function readActionState(
  action: CollectionItemActionDescriptor<unknown>,
  item: unknown,
): CollectionActionState {
  try {
    return action.getState(item);
  } catch (error) {
    return {
      status: "error",
      message:
        error instanceof Error && error.message
          ? error.message
          : m.collection_callback_error(),
    };
  }
}

function readActionLabel(
  action: CollectionItemActionDescriptor<unknown>,
  item: unknown,
) {
  try {
    return action.getLabel?.(item) ?? action.label;
  } catch {
    return action.label;
  }
}

function useCollectionItemAction({
  action,
  item,
  onRejected,
}: CollectionItemActionProps) {
  const [localPending, setLocalPending] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const ownerState = readActionState(action, item);
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
    const result = await runCollectionCallback(
      () => action.run(item),
      m.collection_callback_error(),
    );
    setLocalPending(false);

    if (!result.ok && result.message) {
      setLocalError(result.message);
      onRejected(action.id, result.message);
    }
    return result.ok;
  }, [action, onRejected, ownerState.status, pending, item]);

  const state: EffectiveActionState = {
    disabled: pending || ownerState.status === "disabled",
    message,
    pending,
    status: localError ? "error" : pending ? "pending" : ownerState.status,
  };

  return { run, state };
}

export function CollectionItemActionButton(props: CollectionItemActionProps) {
  const { action } = props;
  const { run, state } = useCollectionItemAction(props);
  const label = readActionLabel(action, props.item);
  const button = (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      disabled={state.disabled}
      data-collection-interactive
      data-collection-action={action.id}
      data-collection-action-state={state.status}
      title={state.message}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation();
        void run();
      }}
    >
      {state.pending ? (
        <LoaderCircle data-icon="inline-start" className="animate-spin" />
      ) : (
        action.icon
      )}
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
          <span className="inline-flex" data-collection-interactive>
            {button}
          </span>
        </TooltipTrigger>
        <TooltipContent>{state.message}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

function CollectionItemActionDropdownItem(
  props: CollectionItemActionProps & {
    onSuccess(): void;
  },
) {
  const { action, onSuccess } = props;
  const { run, state } = useCollectionItemAction(props);
  const label = readActionLabel(action, props.item);

  return (
    <DropdownMenuItem
      disabled={state.disabled}
      data-collection-action={action.id}
      data-collection-action-state={state.status}
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
      ) : (
        action.icon
      )}
      <span>{label}</span>
      {state.message ? (
        <span className="sr-only"> — {state.message}</span>
      ) : null}
    </DropdownMenuItem>
  );
}

function CollectionItemActionContextItem(props: CollectionItemActionProps) {
  const { action } = props;
  const { run, state } = useCollectionItemAction(props);
  const label = readActionLabel(action, props.item);

  return (
    <ContextMenuItem
      disabled={state.disabled}
      data-collection-action={action.id}
      data-collection-action-state={state.status}
      title={state.message}
      aria-description={state.message}
      onSelect={() => {
        void run();
      }}
    >
      {state.pending ? (
        <LoaderCircle data-icon="inline-start" className="animate-spin" />
      ) : (
        action.icon
      )}
      <span>{label}</span>
      {state.message ? (
        <span className="sr-only"> — {state.message}</span>
      ) : null}
    </ContextMenuItem>
  );
}

export function CollectionItemActionsContextMenu({
  actions,
  item,
  onRejected,
}: {
  actions: readonly CollectionItemActionDescriptor<unknown>[];
  item: unknown;
  onRejected(actionId: string, message: string): void;
}) {
  if (actions.length === 0) return null;

  return (
    <ContextMenuGroup>
      {actions.map((action) => (
        <CollectionItemActionContextItem
          key={action.id}
          action={action}
          item={item}
          onRejected={onRejected}
        />
      ))}
    </ContextMenuGroup>
  );
}

export function CollectionItemActionsDropdownMenu({
  actions,
  item,
  onRejected,
}: {
  actions: readonly CollectionItemActionDescriptor<unknown>[];
  item: unknown;
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
          aria-label={m.collection_item_actions()}
          data-collection-interactive
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
            <CollectionItemActionDropdownItem
              key={action.id}
              action={action}
              item={item}
              onRejected={onRejected}
              onSuccess={() => setOpen(false)}
            />
          ))}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The actions of an item its owner shows for it now. */
export function visibleItemActions(
  actions: readonly CollectionItemActionDescriptor<unknown>[] | undefined,
  item: unknown,
) {
  return (actions ?? []).filter((action) => {
    try {
      return action.isVisible?.(item) ?? true;
    } catch {
      return true;
    }
  });
}
