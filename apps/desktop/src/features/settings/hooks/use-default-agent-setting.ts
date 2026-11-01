import { useCallback, useState } from "react";
import { toast } from "sonner";
import * as m from "@/paraglide/messages.js";
import {
  chooseDefaultAgent,
  knownDefaultAgent,
  useChatAgents,
  useChosenAgentSettings,
  useDefaultAgent,
  type AgentSetting,
  type DefaultAgent,
  type UpdateAgentSettingValues,
} from "@/features/agent-sessions/agent-settings-popover";
import { useSpace } from "@/features/space";
import { getNativeErrorMessage } from "@/platform/native/errors";

const NO_VALUES: DefaultAgent["settings"] = [];

function save(next: DefaultAgent | null) {
  void chooseDefaultAgent(next).catch((error: unknown) => {
    toast.error(m.settings_default_agent_failed(), {
      description: getNativeErrorMessage(error),
    });
  });
}

/**
 * The device's default agent in the agent settings (Stage 11 `03`): chosen
 * in the agent settings popover and stored at once. While the popover is
 * open the agent's draft session runs in the root of the window's project
 * and is released once it closes; without a project the agent's last
 * declarations show its settings. Opening writes nothing: a stored value
 * the agent no longer offers shows with a note until another is chosen.
 */
export function useDefaultAgentSetting() {
  const [open, setOpen] = useState(false);
  const { value: defaultAgent, loaded } = useDefaultAgent();
  // The agents the chat offers are read each time the popover opens.
  const chatAgents = useChatAgents(open);
  const projectRoot = useSpace((state) => state.activeRootPath);
  const agent = defaultAgent?.agent ?? null;
  const updateValues = useCallback<UpdateAgentSettingValues>(
    (change) => {
      const current = knownDefaultAgent();
      // A change of another agent the default agent no longer is.
      if (!current || current.agent !== agent) return;
      save({ agent: current.agent, settings: change(current.settings) });
    },
    [agent],
  );
  const chosen = useChosenAgentSettings({
    agent,
    cwd: open ? projectRoot : null,
    offer:
      chatAgents.agents?.agents.find((candidate) => candidate.agent === agent)
        ?.offer ?? null,
    values: defaultAgent?.settings ?? NO_VALUES,
    updateValues,
    // A stored value the agent no longer offers stays until a new choice.
    keepUndeclared: true,
  });
  // The entry keeps naming the values while the opened agent starts.
  const [named, setNamed] = useState<{
    agent: string;
    settings: AgentSetting[];
  } | null>(null);
  if (agent && chosen.settings && named?.settings !== chosen.settings) {
    setNamed({ agent, settings: chosen.settings });
  }
  return {
    loaded,
    open,
    setOpen,
    agent,
    agents: chatAgents.agents?.agents ?? [],
    chooseAgent: (next: string) => {
      if (next !== agent) save({ agent: next, settings: [] });
    },
    retry: () => {
      chatAgents.reload();
      chosen.retry();
    },
    /** The settings the entry names. */
    summarySettings:
      chosen.settings ?? (named?.agent === agent ? named.settings : null),
    chosen,
    /** The settings can change now; otherwise the rows only show them. */
    canChange: chosen.keepsValues || chosen.snapshot?.writer === "acp",
  };
}
