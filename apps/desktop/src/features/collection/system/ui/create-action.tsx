import { useCallback, useRef, useState } from "react";
import { LoaderCircle, Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
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
  SystemCollectionCreateAction,
} from "../model/types";

interface EffectiveCreateState {
  disabled: boolean;
  message?: string;
  pending: boolean;
  status: SystemCollectionActionState["status"];
}

function readActionState(
  action: SystemCollectionCreateAction,
): SystemCollectionActionState {
  try {
    return action.getState();
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

function useSystemCollectionPresentationAction(
  action: SystemCollectionCreateAction,
  onRejected: (message: string) => void,
) {
  const [localPending, setLocalPending] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const runningRef = useRef(false);
  const ownerState = readActionState(action);
  const pending = localPending || ownerState.status === "pending";
  const message =
    localError ??
    (ownerState.status === "disabled"
      ? ownerState.reason
      : ownerState.status === "error"
        ? ownerState.message
        : undefined);
  const state: EffectiveCreateState = {
    disabled: pending || ownerState.status === "disabled",
    message,
    pending,
    status: localError ? "error" : pending ? "pending" : ownerState.status,
  };

  const run = useCallback(async () => {
    if (state.disabled || runningRef.current) {
      return;
    }

    runningRef.current = true;
    setLocalPending(true);
    setLocalError(null);
    const result = await runSystemCollectionCallback(
      () => action.run(),
      m.system_collection_callback_error(),
    );
    runningRef.current = false;
    setLocalPending(false);
    if (!result.ok && result.message) {
      setLocalError(result.message);
      onRejected(result.message);
    }
  }, [action, onRejected, state.disabled]);

  return { run, state };
}

export function SystemCollectionCreateActionButton({
  action,
  onRejected,
}: {
  action: SystemCollectionCreateAction;
  onRejected(message: string): void;
}) {
  const { run, state } = useSystemCollectionPresentationAction(
    action,
    onRejected,
  );

  const button = (
    <Button
      type="button"
      size="sm"
      disabled={state.disabled}
      data-system-collection-create={action.id}
      data-system-collection-create-state={state.status}
      title={state.message}
      onClick={() => void run()}
    >
      {state.pending ? (
        <LoaderCircle data-icon="inline-start" className="animate-spin" />
      ) : (
        <Plus data-icon="inline-start" />
      )}
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
          <span className="inline-flex">{button}</span>
        </TooltipTrigger>
        <TooltipContent>{state.message}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
