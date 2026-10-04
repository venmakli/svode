import {
  openAgentSession,
  type AgentSessionOpeningDto,
} from "@/platform/agent-runtime/agent-runtime-api";

export {
  agentRuntimeErrorCode,
  agentSettingRefusal,
  answerAgentInteraction,
  cancelAgentTurn,
  holdDraftAgent,
  promptAgentSession,
  readAgentActivityDetail,
  releaseAgentSession,
  releaseDraftAgent,
  setAgentSessionSetting,
  startAgentSession,
} from "@/platform/agent-runtime/agent-runtime-api";
export type {
  AgentActivityItemDto,
  AgentCheckDto,
  AgentDetailBlockDto,
  AgentDetailOutcomeDto,
  AgentExternalLivenessDto,
  AgentInteractionAnswerDto,
  AgentLaunchUnavailableDto,
  AgentPendingInteractionDto,
  AgentQuestionFieldDto,
  AgentRuntimeErrorCode,
  AgentSessionCommandDto,
  AgentSessionKeyDto,
  AgentSessionOpeningDto,
  AgentSessionSnapshotDto,
  AgentSessionUsageDto,
  AgentSettingRefusalDto,
  AgentSettingValueDto,
  StartedAgentSessionDto,
} from "@/platform/agent-runtime/agent-runtime-api";
export { listChatAgents } from "@/platform/agent-setup/agent-setup-api";
export { signInAgent } from "@/platform/agent-setup/agent-setup-api";

const openings = new Map<string, Promise<AgentSessionOpeningDto>>();

/**
 * Opens a listed session in the chat. A surface mounted twice for one
 * session shares the opening in flight, so the agent replays it once.
 */
export function openSessionInChat(
  projectPath: string,
  sessionId: string,
  attach: boolean,
): Promise<AgentSessionOpeningDto> {
  const key = `${projectPath}\n${sessionId}\n${attach}`;
  const inFlight = openings.get(key);
  if (inFlight) return inFlight;
  const opening = openAgentSession(projectPath, sessionId, attach).finally(() =>
    openings.delete(key),
  );
  openings.set(key, opening);
  return opening;
}
