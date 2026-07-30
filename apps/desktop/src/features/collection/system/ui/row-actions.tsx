import { useCallback, useState } from "react";
import { LoaderCircle, MoreHorizontal } from "lucide-react";

import { Button } from "@/components/ui/button";
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

import { runSystemCollectionCallback } from "../lib/interaction";
import type {
  SystemCollectionActionState,
  SystemCollectionRowActionDescriptor,
} from "../model/types";

interface SystemCollectionRowActionProps {
  action: SystemCollectionRowActionDescriptor<unknown>;
  row: unknown;
  onRejected(actionId: string, message: string): void;
}

interface EffectiveActionState {
  disabled: boolean;
  message?: string;
  pending: boolean;
  status: SystemCollectionActionState["status"];
}

function readActionState(
  action: SystemCollectionRowActionDescriptor<unknown>,
  row: unknown,
): SystemCollectionActionState {
  try {
    return action.getState(row);
  } catch (error) {
    return {
      status: "error",
      message:
        error instanceof Error && error.message
          ? error.message
          : m.system_collection_callback_error(),
    };
  }
}

function useSystemCollectionRowAction({
  action,
  row,
  onRejected,
}: SystemCollectionRowActionProps) {
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
    const result = await runSystemCollectionCallback(
      () => action.run(row),
      m.system_collection_callback_error(),
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
    status: localError ? "error" : ownerState.status,
  };

  return { run, state };
}

export function SystemCollectionRowActionButton(
  props: SystemCollectionRowActionProps,
) {
  const { action } = props;
  const { run, state } = useSystemCollectionRowAction(props);
  const button = (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      disabled={state.disabled}
      data-system-collection-interactive
      data-system-collection-action={action.id}
      data-system-collection-action-state={state.status}
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
      {action.label}
    </Button>
  );

  if (!state.message) {
    return button;
  }

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex" data-system-collection-interactive>
            {button}
          </span>
        </TooltipTrigger>
        <TooltipContent>{state.message}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

function SystemCollectionRowActionMenuItem(
  props: SystemCollectionRowActionProps & {
    onSuccess(): void;
  },
) {
  const { action, onSuccess } = props;
  const { run, state } = useSystemCollectionRowAction(props);

  return (
    <DropdownMenuItem
      disabled={state.disabled}
      data-system-collection-action={action.id}
      data-system-collection-action-state={state.status}
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
      <span className="min-w-0 truncate">{action.label}</span>
      {state.message ? (
        <span className="ml-auto max-w-40 truncate text-xs text-muted-foreground">
          {state.message}
        </span>
      ) : null}
    </DropdownMenuItem>
  );
}

export function SystemCollectionRowActionsMenu({
  actions,
  row,
  onRejected,
}: {
  actions: readonly SystemCollectionRowActionDescriptor<unknown>[];
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
          aria-label={m.system_collection_row_actions()}
          data-system-collection-interactive
          className="shrink-0 text-muted-foreground opacity-0 transition-opacity group-focus-within/list-row:opacity-100 group-hover/list-row:opacity-100 group-focus-within/gallery-card:opacity-100 group-hover/gallery-card:opacity-100"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
        >
          <MoreHorizontal />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuGroup>
          {actions.map((action) => (
            <SystemCollectionRowActionMenuItem
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
