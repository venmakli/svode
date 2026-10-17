import {
  openAgentSession,
  type AgentSessionOpeningDto,
  type AgentSettingValueDto,
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
  AgentMediaSegmentDto,
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
  AgentToolKindDto,
  StartedAgentSessionDto,
} from "@/platform/agent-runtime/agent-runtime-api";
export { listChatAgents } from "@/platform/agent-setup/agent-setup-api";
export { signInAgent } from "@/platform/agent-setup/agent-setup-api";

const openings = new Map<string, Promise<AgentSessionOpeningDto>>();

/**
 * Opens a listed session in the chat; an attaching opening applies
 * `settings` first. A surface mounted twice for one session shares the
 * opening in flight, so the agent replays it once.
 */
export function openSessionInChat(
  projectPath: string,
  sessionId: string,
  attach: boolean,
  settings: AgentSettingValueDto[] = [],
): Promise<AgentSessionOpeningDto> {
  const key = `${projectPath}\n${sessionId}\n${attach}\n${JSON.stringify(settings)}`;
  const inFlight = openings.get(key);
  if (inFlight) return inFlight;
  const opening = openAgentSession(
    projectPath,
    sessionId,
    attach,
    settings,
  ).finally(() => openings.delete(key));
  openings.set(key, opening);
  return opening;
}
