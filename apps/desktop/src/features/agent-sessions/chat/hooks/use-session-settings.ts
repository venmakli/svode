import { useCallback, useState } from "react";
import {
  agentSettingRefusal,
  setAgentSessionSetting,
  type AgentSessionKeyDto,
  type AgentSettingRefusalDto,
  type AgentSettingValueDto,
} from "../api/chat";
import { errorMessage } from "./use-session-composer";

/** A setting change that did not apply; the setting keeps its value. */
export type SettingChangeRefusal =
  | AgentSettingRefusalDto
  | {
      setting: string;
      value: string;
      reason: { kind: "error"; message: string };
    };

/**
 * Changes of the session settings through the runtime (`02` C6): a value
 * shows only once the agent confirmed it in the session's settings, and a
 * refusal names the value and why the earlier one stays.
 */
export function useSessionSettings(session: AgentSessionKeyDto | null) {
  const [changing, setChanging] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<SettingChangeRefusal | null>(null);
  const agent = session?.agent;
  const namespace = session?.namespace;
  const sessionId = session?.sessionId;

  const change = useCallback(
    async (value: AgentSettingValueDto): Promise<boolean> => {
      if (!agent || !namespace || !sessionId) return false;
      setRefusal(null);
      setChanging(value.setting);
      try {
        await setAgentSessionSetting({ agent, namespace, sessionId }, value);
        return true;
      } catch (error) {
        setRefusal(
          agentSettingRefusal(error) ?? {
            ...value,
            reason: { kind: "error", message: errorMessage(error) },
          },
        );
        return false;
      } finally {
        setChanging(null);
      }
    },
    [agent, namespace, sessionId],
  );

  return {
    change,
    /** The setting whose change waits for the agent. */
    changing,
    refusal,
    /** A refusal the draft found itself, as for a value it kept. */
    refuse: setRefusal,
    dismissRefusal: useCallback(() => setRefusal(null), []),
  };
}
