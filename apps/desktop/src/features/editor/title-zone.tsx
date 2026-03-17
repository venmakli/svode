import { useState, useRef, useCallback, type KeyboardEvent } from "react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import * as m from "@/paraglide/messages.js";

const EMOJI_LIST = [
  "📄", "📝", "📋", "📌", "📎", "📁", "📂", "📚",
  "🏗️", "⚙️", "🔧", "🔨", "🚀", "💡", "🎯", "🎨",
  "🔍", "📊", "📈", "💻", "🖥️", "🌐", "🔒", "🔑",
  "⭐", "❤️", "🔥", "✅", "❌", "⚠️", "ℹ️", "💬",
  "👤", "👥", "🏠", "📱", "🎵", "🎮", "📸", "🎬",
];

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
  const [emojiOpen, setEmojiOpen] = useState(false);
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
      <Popover open={emojiOpen} onOpenChange={setEmojiOpen}>
        <PopoverTrigger asChild>
          <button
            className="text-3xl hover:bg-muted rounded-md p-1 transition-colors shrink-0 mt-0.5"
            type="button"
          >
            {icon || "📄"}
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-64 p-2" align="start">
          <div className="grid grid-cols-8 gap-1">
            {EMOJI_LIST.map((emoji) => (
              <button
                key={emoji}
                className="text-xl p-1 hover:bg-muted rounded transition-colors"
                onClick={() => {
                  onIconChange(emoji);
                  setEmojiOpen(false);
                }}
                type="button"
              >
                {emoji}
              </button>
            ))}
          </div>
        </PopoverContent>
      </Popover>
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
