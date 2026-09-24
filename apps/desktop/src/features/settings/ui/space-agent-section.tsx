import { useId } from "react";
import * as m from "@/paraglide/messages.js";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { RefreshCw } from "lucide-react";
import type { ModelOption } from "@/features/chat";
import type { AvailableAgent, SymlinkHealthReport } from "../model";
import {
  CliAgentStatusBadge,
  cliAgentName,
  cliAgentNextStep,
  cliAgentStatus,
} from "./cli-agent-status";
import { SettingsGroup, SettingsItem, SettingsRow } from "./settings-layout";
import { SettingsSelect } from "./settings-select";

interface SpaceAgentSectionProps {
  agents: AvailableAgent[];
  enabledClis: string[];
  defaultModel: string;
  systemPrompt: string;
  availableModels: ModelOption[];
  healthReport: SymlinkHealthReport | null;
  refreshing: boolean;
  onDefaultModelChange: (value: string) => void;
  onSystemPromptChange: (value: string) => void;
  onSystemPromptBlur: () => void;
  onCliToggle: (cliName: string, enabled: boolean) => void;
  onRefresh: () => void;
}

export function SpaceAgentSection({
  agents,
  enabledClis,
  defaultModel,
  systemPrompt,
  availableModels,
  healthReport,
  refreshing,
  onDefaultModelChange,
  onSystemPromptChange,
  onSystemPromptBlur,
  onCliToggle,
  onRefresh,
}: SpaceAgentSectionProps) {
  const id = useId();
  return (
    <>
      <SettingsGroup title={m.settings_agent_chat_group()}>
        <SettingsRow
          label={m.settings_space_default_model()}
          description={m.settings_space_default_model_desc()}
          htmlFor={`${id}-model`}
        >
          <SettingsSelect
            id={`${id}-model`}
            value={defaultModel}
            onValueChange={onDefaultModelChange}
            options={availableModels.map((model) => ({
              value: model.id,
              label: model.name,
              description: model.description,
            }))}
          />
        </SettingsRow>
        <SettingsRow
          label={m.settings_system_prompt()}
          htmlFor={`${id}-prompt`}
          layout="stacked"
        >
          <Textarea
            id={`${id}-prompt`}
            value={systemPrompt}
            onChange={(event) => onSystemPromptChange(event.target.value)}
            onBlur={onSystemPromptBlur}
            placeholder={m.settings_system_prompt_placeholder()}
            rows={4}
          />
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup
        title={m.settings_space_cli_agents()}
        description={
          healthReport
            ? healthReport.restored > 0
              ? m.settings_space_symlinks_restored({
                  count: String(healthReport.restored),
                })
              : m.settings_space_symlinks_ok()
            : undefined
        }
        action={
          <Button
            variant="outline"
            size="sm"
            onClick={onRefresh}
            disabled={refreshing}
          >
            <RefreshCw
              data-icon="inline-start"
              className={refreshing ? "animate-spin" : undefined}
            />
            {m.settings_space_cli_refresh()}
          </Button>
        }
      >
        {agents.map((agent) => (
          <SettingsItem
            key={agent.name}
            title={cliAgentName(agent)}
            description={cliAgentNextStep(agent)}
            actions={
              <>
                <CliAgentStatusBadge agent={agent} />
                <Switch
                  checked={enabledClis.includes(agent.name)}
                  disabled={cliAgentStatus(agent) !== "authorized"}
                  aria-label={m.settings_space_cli_use({
                    agent: cliAgentName(agent),
                  })}
                  onCheckedChange={(checked) =>
                    onCliToggle(agent.name, checked)
                  }
                />
              </>
            }
          />
        ))}
      </SettingsGroup>
    </>
  );
}
