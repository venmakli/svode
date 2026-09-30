import {
  subscribeAgentSession,
  unsubscribeAgentSession,
  type AgentActivityMessageDto,
  type AgentSessionKeyDto,
  type AgentSessionSnapshotDto,
} from "@/platform/agent-runtime/agent-runtime-api";
import { applyAgentActivityMessage } from "../model/activity";

export {
  agentRuntimeErrorCode,
  answerAgentInteraction,
  cancelAgentTurn,
  promptAgentSession,
  readAgentActivityDetail,
} from "@/platform/agent-runtime/agent-runtime-api";
export type {
  AgentActivityItemDto,
  AgentAnswerOutcomeDto,
  AgentDetailOutcomeDto,
  AgentInteractionAnswerDto,
  AgentPendingInteractionDto,
  AgentRuntimeErrorCode,
  AgentSessionKeyDto,
  AgentSessionSnapshotDto,
} from "@/platform/agent-runtime/agent-runtime-api";

export interface AgentActivityTransport {
  subscribe: (
    session: AgentSessionKeyDto,
    onMessage: (message: AgentActivityMessageDto) => void,
  ) => Promise<number>;
  unsubscribe: (subscription: number) => Promise<void>;
}

const runtimeTransport: AgentActivityTransport = {
  subscribe: subscribeAgentSession,
  unsubscribe: unsubscribeAgentSession,
};

export interface AgentActivitySubscription {
  close: () => void;
}

/**
 * Follows a session's activity: every state starts from a runtime snapshot,
 * so a reload or a lost delivery never replays messages. A seq gap drops the
 * local state and subscribes again.
 */
export function openAgentSessionActivity(
  session: AgentSessionKeyDto,
  onState: (state: AgentSessionSnapshotDto) => void,
  onError: (error: unknown) => void,
  transport: AgentActivityTransport = runtimeTransport,
): AgentActivitySubscription {
  let closed = false;
  let generation = 0;
  let delivery: Promise<number> | null = null;

  const release = (subscription: Promise<number>) => {
    subscription.then((id) => transport.unsubscribe(id)).catch(() => undefined);
  };

  const start = () => {
    const own = ++generation;
    let current: AgentSessionSnapshotDto | null = null;
    const subscription = transport.subscribe(session, (message) => {
      if (closed || own !== generation) return;
      const step = applyAgentActivityMessage(current, message);
      if (step.kind === "state") {
        current = step.state;
        onState(step.state);
      } else if (step.kind === "resubscribe") {
        release(subscription);
        start();
      }
    });
    delivery = subscription;
    subscription.catch((error: unknown) => {
      if (!closed && own === generation) onError(error);
    });
  };

  start();
  return {
    close: () => {
      if (closed) return;
      closed = true;
      if (delivery) release(delivery);
    },
  };
}
