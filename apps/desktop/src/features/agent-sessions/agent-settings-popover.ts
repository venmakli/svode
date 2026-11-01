export {
  AgentSettingsPopover,
  type AgentSettingsChoice,
  type AgentSettingsExtraTab,
  type AgentSettingsPopoverProps,
  type AgentSettingsTab,
} from "./chat/ui/agent-settings-popover";
export type { AgentRecoveryActions } from "./chat/ui/agent-recovery";
export type { DraftAgentState as AgentReadiness } from "./chat/hooks/use-draft-agent";
export type {
  SessionSetting as AgentSetting,
  SettingValue as AgentSettingValue,
} from "./chat/model/session-controls";
// The host seam of the popover outside a session (Stage 11 `03`): the
// agents the chat offers, the device's default agent and the settings of a
// chosen agent with the values its host keeps.
export {
  AgentSettingsSummary,
  useAgentSettingsSummary,
} from "./chat/ui/agent-settings-summary";
export { useChatAgents } from "./chat/hooks/use-chat-agents";
export { useChosenAgentSettings } from "./chat/hooks/use-chosen-agent-settings";
export type { UpdateKeptValues as UpdateAgentSettingValues } from "./chat/hooks/use-draft-settings";
export {
  chooseDefaultAgent,
  knownDefaultAgent,
  useDefaultAgent,
  type DefaultAgentState,
} from "./chat/hooks/use-default-agent";
export type { ChatAgent, DefaultAgent } from "./chat/model/agents";
