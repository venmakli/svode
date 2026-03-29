import { useRef, useCallback, type KeyboardEvent } from "react";
import { SmilePlus } from "lucide-react";
import { EmojiPicker } from "@/components/ui/emoji-picker";
import * as m from "@/paraglide/messages.js";

interface TitleZoneProps {
  title: string;
  icon: string | null;
  onTitleChange: (title: string) => void;
  onIconChange: (icon: string) => void;
  onEnter: () => void;
}

export function TitleZone({
  title,
  icon,
  onTitleChange,
  onIconChange,
  onEnter,
}: TitleZoneProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter") {
        e.preventDefault();
        onEnter();
      }
    },
    [onEnter],
  );

  // Treat default "Untitled" as empty so it shows as placeholder
  const defaultTitle = m.editor_untitled();
  const isDefault = title === defaultTitle || title === "Untitled";
  const displayValue = isDefault ? "" : title;

  return (
    <div className="flex items-start gap-3 mb-1">
      <div className="mt-0.5">
        {icon ? (
          <EmojiPicker value={icon} onChange={onIconChange} size="lg" />
        ) : (
          <EmojiPicker
            value=""
            onChange={onIconChange}
            size="lg"
            placeholder={<SmilePlus className="h-7 w-7 text-muted-foreground/40" />}
          />
        )}
      </div>
      <input
        ref={inputRef}
        type="text"
        value={displayValue}
        onChange={(e) => onTitleChange(e.target.value || defaultTitle)}
        onKeyDown={handleKeyDown}
        placeholder={defaultTitle}
        className="flex-1 text-3xl font-bold bg-transparent border-none outline-none placeholder:text-muted-foreground/40"
      />
    </div>
  );
}
