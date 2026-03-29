import { useRef, useCallback, type KeyboardEvent } from "react";
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

  return (
    <div className="flex items-start gap-3 mb-4">
      <div className="mt-0.5">
        <EmojiPicker value={icon || "\u{1F4C4}"} onChange={onIconChange} size="lg" />
      </div>
      <input
        ref={inputRef}
        type="text"
        value={title}
        onChange={(e) => onTitleChange(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={m.editor_untitled()}
        className="flex-1 text-3xl font-bold bg-transparent border-none outline-none placeholder:text-muted-foreground/50"
      />
    </div>
  );
}
