import { useState } from "react";
import data from "@emoji-mart/data";
import Picker from "@emoji-mart/react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useTheme } from "@/components/ui/theme-provider";

interface EmojiPickerProps {
  value: string;
  onChange: (emoji: string) => void;
  /** Size of the trigger button text */
  size?: "sm" | "md" | "lg";
}

export function EmojiPicker({ value, onChange, size = "lg" }: EmojiPickerProps) {
  const [open, setOpen] = useState(false);
  const { theme } = useTheme();

  const sizeClasses = {
    sm: "text-xl p-1",
    md: "text-2xl p-1",
    lg: "text-3xl p-1",
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          className={`${sizeClasses[size]} hover:bg-muted rounded-md transition-colors shrink-0`}
          type="button"
        >
          {value || "\u{1F4C4}"}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0 border-none" align="start">
        <Picker
          data={data}
          onEmojiSelect={(emoji: { native: string }) => {
            onChange(emoji.native);
            setOpen(false);
          }}
          theme={theme === "system" ? "auto" : theme}
          previewPosition="none"
          skinTonePosition="search"
          maxFrequentRows={1}
        />
      </PopoverContent>
    </Popover>
  );
}
