import { useCallback, useRef, useState } from "react";
import { ChevronDown, LoaderCircle, Plus } from "lucide-react";

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

import { runCollectionCallback } from "../lib/interaction";
import type {
  CollectionActionState,
  CollectionCreateCapability,
  CollectionCreateIntent,
} from "../model/types";

interface EffectiveCreateState {
  disabled: boolean;
  message?: string;
  pending: boolean;
  status: CollectionActionState["status"];
}

function readIntentState(
  intent: CollectionCreateIntent,
): CollectionActionState {
  try {
    return intent.getState();
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

function useCollectionCreateIntent(
  intent: CollectionCreateIntent,
  onRejected: (targetId: string, message: string) => void,
) {
  const [localPending, setLocalPending] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const runningRef = useRef(false);
  const ownerState = readIntentState(intent);
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
    if (state.disabled || runningRef.current) return;
    runningRef.current = true;
    setLocalPending(true);
    setLocalError(null);
    const result = await runCollectionCallback(
      () => intent.run(),
      m.collection_callback_error(),
    );
    runningRef.current = false;
    setLocalPending(false);
    if (!result.ok && result.message) {
      setLocalError(result.message);
      onRejected(intent.id, result.message);
    }
  }, [intent, onRejected, state.disabled]);

  return { run, state };
}

export function CollectionCreateControl({
  capability,
  onRejected,
}: {
  capability: CollectionCreateCapability;
  onRejected(targetId: string, message: string): void;
}) {
  if (capability.intents.length === 0) return null;
  const intent = capability.intents[0];
  if (capability.intents.length === 1 && intent) {
    return <CollectionCreateButton intent={intent} onRejected={onRejected} />;
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" size="sm" data-collection-create-menu>
          <Plus data-icon="inline-start" />
          {capability.label}
          <ChevronDown data-icon="inline-end" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuGroup>
          {capability.intents.map((candidate) => (
            <CollectionCreateMenuItem
              key={candidate.id}
              intent={candidate}
              onRejected={onRejected}
            />
          ))}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function CollectionCreateButton({
  intent,
  onRejected,
}: {
  intent: CollectionCreateIntent;
  onRejected(targetId: string, message: string): void;
}) {
  const { run, state } = useCollectionCreateIntent(intent, onRejected);
  const button = (
    <Button
      type="button"
      size="sm"
      disabled={state.disabled}
      data-collection-create={intent.id}
      data-collection-create-state={state.status}
      title={state.message}
      onClick={() => void run()}
    >
      {state.pending ? (
        <LoaderCircle data-icon="inline-start" className="animate-spin" />
      ) : (
        <Plus data-icon="inline-start" />
      )}
      {intent.label}
    </Button>
  );
  if (!state.message) return button;
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

function CollectionCreateMenuItem({
  intent,
  onRejected,
}: {
  intent: CollectionCreateIntent;
  onRejected(targetId: string, message: string): void;
}) {
  const { run, state } = useCollectionCreateIntent(intent, onRejected);
  return (
    <DropdownMenuItem
      disabled={state.disabled}
      data-collection-create={intent.id}
      data-collection-create-state={state.status}
      title={state.message}
      onSelect={() => void run()}
    >
      {state.pending ? <LoaderCircle className="animate-spin" /> : <Plus />}
      {intent.label}
    </DropdownMenuItem>
  );
}
