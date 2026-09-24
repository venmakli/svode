import { useId } from "react";
import * as m from "@/paraglide/messages.js";
import { Textarea } from "@/components/ui/textarea";
import type { ModelOption } from "@/features/chat";
import { SettingsGroup, SettingsRow } from "./settings-layout";
import { SettingsSelect } from "./settings-select";

interface SpaceDefaultsSectionProps {
  model: string;
  prompt: string;
  availableModels: ModelOption[];
  onModelChange: (value: string) => void;
  onPromptChange: (value: string) => void;
  onPromptBlur: () => void;
}

export function SpaceDefaultsSection({
  model,
  prompt,
  availableModels,
  onModelChange,
  onPromptChange,
  onPromptBlur,
}: SpaceDefaultsSectionProps) {
  const id = useId();
  return (
    <SettingsGroup
      title={m.settings_defaults_group()}
      description={m.settings_defaults_description()}
    >
      <SettingsRow
        label={m.settings_space_default_model()}
        htmlFor={`${id}-model`}
      >
        <SettingsSelect
          id={`${id}-model`}
          value={model}
          placeholder="—"
          onValueChange={onModelChange}
          options={availableModels.map((option) => ({
            value: option.id,
            label: option.name,
            description: option.description,
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
          value={prompt}
          onChange={(event) => onPromptChange(event.target.value)}
          onBlur={onPromptBlur}
          placeholder={m.settings_system_prompt_placeholder()}
          rows={3}
        />
      </SettingsRow>
    </SettingsGroup>
  );
}
