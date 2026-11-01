import { ChevronDown } from "lucide-react";
import * as m from "@/paraglide/messages.js";
import { Button } from "@/components/ui/button";
import {
  AgentSettingsPopover,
  AgentSettingsSummary,
  useAgentSettingsSummary,
} from "@/features/agent-sessions/agent-settings-popover";
import { useDefaultAgentSetting } from "../hooks/use-default-agent-setting";
import { SettingsItem } from "./settings-layout";

/** Built-in agents have their own sign-in command; custom agents do not. */
const CUSTOM_PREFIX = "custom-";

/**
 * "Default agent", the first row of the agents (Stage 11 `03`, host
 * differences): the agent, its model and reasoning, or "Not chosen"; the
 * agent settings popover chooses the agent among those the chat offers and
 * its settings with the mode last, each stored at once, and stays open.
 */
export function DefaultAgentRow({
  onSignIn,
}: {
  /** Opens the sign-in terminal of a built-in agent. */
  onSignIn: (agent: string) => void;
}) {
  const setting = useDefaultAgentSetting();
  const { agent, chosen } = setting;
  const summary = useAgentSettingsSummary(
    agent,
    setting.summarySettings,
    m.settings_default_agent_none(),
  );
  return (
    <SettingsItem
      title={m.settings_default_agent()}
      aria-busy={!setting.loaded || undefined}
      actions={
        <AgentSettingsPopover
          side="bottom"
          align="end"
          open={setting.open}
          onOpenChange={setting.setOpen}
          agent={agent}
          choice={{
            agents: setting.agents,
            onChoose: setting.chooseAgent,
            readiness: chosen.readiness,
            recovery: {
              onSignIn:
                agent && !agent.startsWith(CUSTOM_PREFIX)
                  ? () => onSignIn(agent)
                  : null,
              // The agents are the rows under this one.
              onOpenSettings: () => {},
              onRetry: setting.retry,
            },
            settingsAfterSend: chosen.settingsAfterSend,
            recorded: chosen.recorded,
            withoutVariants: chosen.withoutVariants,
          }}
          settings={chosen.settings}
          modeRow
          canChange={setting.canChange}
          changing={chosen.changing}
          onChange={(value) => void chosen.changeSetting(value)}
          trigger={
            <Button
              variant="outline"
              size="sm"
              disabled={!setting.loaded}
              className="max-w-64 min-w-0 gap-1.5"
              aria-label={m.settings_default_agent_button({
                agent: summary.text,
              })}
            >
              <AgentSettingsSummary
                agent={agent}
                settings={setting.summarySettings}
                empty={m.settings_default_agent_none()}
              />
              <ChevronDown className="text-muted-foreground" />
            </Button>
          }
        />
      }
    />
  );
}
