import { useCallback, useRef, useState } from "react";
import { ChevronDown, LoaderCircle, Plus } from "lucide-react";
import { toast } from "sonner";

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

function effectiveIntentState(
  intent: CollectionCreateIntent,
  runningIntentId: string | null,
): EffectiveCreateState {
  const ownerState = readIntentState(intent);
  const pending =
    runningIntentId === intent.id || ownerState.status === "pending";
  return {
    disabled:
      runningIntentId !== null || pending || ownerState.status === "disabled",
    message:
      ownerState.status === "disabled"
        ? ownerState.reason
        : ownerState.status === "error"
          ? ownerState.message
          : undefined,
    pending,
    status: pending ? "pending" : ownerState.status,
  };
}

/**
 * Runs one intent of the create control at a time. The control, not the
 * element that started the intent, owns its progress and refusal: a menu item
 * closes on select, so its own state would never be seen. A refusal is always
 * shown to the user; the host callback is an extra channel.
 */
function useCollectionCreateRunner(
  onRejected: (targetId: string, message: string) => void,
) {
  const [runningIntentId, setRunningIntentId] = useState<string | null>(null);
  const runningRef = useRef(false);

  const run = useCallback(
    async (intent: CollectionCreateIntent) => {
      if (runningRef.current) return;
      if (effectiveIntentState(intent, null).disabled) return;
      runningRef.current = true;
      setRunningIntentId(intent.id);
      const result = await runCollectionCallback(
        () => intent.run(),
        m.collection_callback_error(),
      );
      runningRef.current = false;
      setRunningIntentId(null);
      if (!result.ok && result.message) {
        toast.error(result.message);
        onRejected(intent.id, result.message);
      }
    },
    [onRejected],
  );

  return { run, runningIntentId };
}

export function CollectionCreateControl({
  capability,
  onRejected,
}: {
  capability: CollectionCreateCapability;
  onRejected(targetId: string, message: string): void;
}) {
  const { run, runningIntentId } = useCollectionCreateRunner(onRejected);
  if (capability.intents.length === 0) return null;
  const intent = capability.intents[0];
  if (capability.intents.length === 1 && intent) {
    return (
      <CollectionCreateButton
        intent={intent}
        state={effectiveIntentState(intent, runningIntentId)}
        onRun={() => void run(intent)}
      />
    );
  }
  const intents = capability.intents.map((candidate) => ({
    intent: candidate,
    state: effectiveIntentState(candidate, runningIntentId),
  }));
  const pending = intents.some(({ state }) => state.pending);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          size="sm"
          disabled={pending}
          aria-busy={pending || undefined}
          data-collection-create-menu
          data-collection-create-state={pending ? "pending" : "idle"}
        >
          {pending ? (
            <LoaderCircle data-icon="inline-start" className="animate-spin" />
          ) : (
            <Plus data-icon="inline-start" />
          )}
          {capability.label}
          <ChevronDown data-icon="inline-end" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuGroup>
          {intents.map(({ intent: candidate, state }) => (
            <DropdownMenuItem
              key={candidate.id}
              disabled={state.disabled}
              data-collection-create={candidate.id}
              data-collection-create-state={state.status}
              title={state.message}
              onSelect={() => void run(candidate)}
            >
              <Plus />
              {candidate.label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function CollectionCreateButton({
  intent,
  state,
  onRun,
}: {
  intent: CollectionCreateIntent;
  state: EffectiveCreateState;
  onRun(): void;
}) {
  const button = (
    <Button
      type="button"
      size="sm"
      disabled={state.disabled}
      aria-busy={state.pending || undefined}
      data-collection-create={intent.id}
      data-collection-create-state={state.status}
      title={state.message}
      onClick={onRun}
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
