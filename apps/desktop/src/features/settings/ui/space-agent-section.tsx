import { useId } from "react";
import * as m from "@/paraglide/messages.js";
import { Textarea } from "@/components/ui/textarea";
import type { ModelOption } from "@/features/chat";
import { SettingsGroup, SettingsRow } from "./settings-layout";
import { SettingsSelect } from "./settings-select";

interface SpaceAgentSectionProps {
  defaultModel: string;
  systemPrompt: string;
  availableModels: ModelOption[];
  onDefaultModelChange: (value: string) => void;
  onSystemPromptChange: (value: string) => void;
  onSystemPromptBlur: () => void;
}

export function SpaceAgentSection({
  defaultModel,
  systemPrompt,
  availableModels,
  onDefaultModelChange,
  onSystemPromptChange,
  onSystemPromptBlur,
}: SpaceAgentSectionProps) {
  const id = useId();
  return (
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
  );
}
