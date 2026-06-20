import * as m from "@/paraglide/messages.js";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import type { ModelOption } from "@/features/chat";

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
  return (
    <div className="flex max-w-sm flex-col gap-6">
      <p className="text-sm text-muted-foreground">
        {m.settings_defaults_description()}
      </p>
      <div className="flex flex-col gap-2">
        <Label>{m.settings_space_default_model()}</Label>
        <Select value={model} onValueChange={onModelChange}>
          <SelectTrigger className="w-full">
            <SelectValue placeholder="—" />
          </SelectTrigger>
          <SelectContent>
            {availableModels.map((option) => (
              <SelectItem key={option.id} value={option.id}>
                {option.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="flex flex-col gap-2">
        <Label>{m.settings_system_prompt()}</Label>
        <Textarea
          value={prompt}
          onChange={(event) => onPromptChange(event.target.value)}
          onBlur={onPromptBlur}
          placeholder={m.settings_system_prompt_placeholder()}
          rows={3}
        />
      </div>
    </div>
  );
}
