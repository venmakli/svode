import * as m from "@/paraglide/messages.js";
import { EmojiPicker } from "@/components/ui/emoji-picker";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

interface SpaceGeneralSectionProps {
  icon: string;
  name: string;
  description: string;
  onIconChange: (value: string) => void;
  onNameChange: (value: string) => void;
  onNameBlur: () => void;
  onDescriptionChange: (value: string) => void;
  onDescriptionBlur: () => void;
}

export function SpaceGeneralSection({
  icon,
  name,
  description,
  onIconChange,
  onNameChange,
  onNameBlur,
  onDescriptionChange,
  onDescriptionBlur,
}: SpaceGeneralSectionProps) {
  return (
    <div className="flex max-w-sm flex-col gap-4">
      <div className="flex flex-col gap-2">
        <Label htmlFor="ws-settings-name">{m.space_name_label()}</Label>
        <div className="flex gap-2">
          <EmojiPicker value={icon} onChange={onIconChange} size="sm" />
          <Input
            id="ws-settings-name"
            value={name}
            onChange={(event) => onNameChange(event.target.value)}
            onBlur={onNameBlur}
            placeholder={m.space_name_placeholder()}
            className="flex-1"
          />
        </div>
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="ws-settings-desc">{m.space_description_label()}</Label>
        <Textarea
          id="ws-settings-desc"
          value={description}
          onChange={(event) => onDescriptionChange(event.target.value)}
          onBlur={onDescriptionBlur}
          placeholder={m.space_description_placeholder()}
          rows={3}
        />
      </div>
    </div>
  );
}
