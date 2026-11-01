import { Button } from "@/components/ui/button";
import { useAgentAdapterDictionary } from "@/features/agent-adapters";
import * as m from "@/paraglide/messages.js";

import { routineLaunchRefusalText } from "../lib/routine-launch-refusal";
import type {
  RoutineLaunchRecoveryActions,
  RoutineLaunchRefusal,
} from "../model/types";

/**
 * The reason of a refused launch and the one place it is fixed: the Agent
 * Actor's editor for its binding, or the agent settings for the device's
 * default agent and the agents' readiness.
 */
export function RoutineLaunchRefusalNotice({
  actorId,
  recovery,
  refusal,
}: {
  actorId: string | null;
  recovery: RoutineLaunchRecoveryActions;
  refusal: RoutineLaunchRefusal;
}) {
  const agents = useAgentAdapterDictionary();
  const action =
    refusal.recovery === "actor_editor"
      ? actorId && recovery.onOpenAgentActor
        ? {
            label: m.routines_refusal_open_actor(),
            run: () => recovery.onOpenAgentActor?.(actorId),
          }
        : null
      : recovery.onOpenAgentSettings
        ? {
            label: m.routines_refusal_open_agent_settings(),
            run: () => recovery.onOpenAgentSettings?.(),
          }
        : null;
  return (
    <span className="flex min-w-0 flex-col items-start gap-1">
      <span className="break-words">
        {routineLaunchRefusalText(refusal, agents.label)}
      </span>
      {refusal.detail ? (
        <span className="break-words text-xs text-muted-foreground">
          {refusal.detail}
        </span>
      ) : null}
      {action ? (
        <Button
          type="button"
          variant="link"
          size="sm"
          className="h-auto p-0"
          onClick={action.run}
        >
          {action.label}
        </Button>
      ) : null}
    </span>
  );
}
