import {
  useRef,
  useCallback,
  useEffect,
  useState,
  type KeyboardEvent,
} from "react";
import { SmilePlus } from "lucide-react";
import { EmojiPicker } from "@/components/ui/emoji-picker";
import { cn } from "@/lib/utils";
import * as m from "@/paraglide/messages.js";

interface TitleZoneProps {
  title: string;
  icon: string | null;
  description: string;
  onTitleChange: (title: string) => void;
  onIconChange: (icon: string) => void;
  onDescriptionChange: (description: string) => void;
  onBodyFocus: () => void;
}

export function TitleZone({
  title,
  icon,
  description,
  onTitleChange,
  onIconChange,
  onDescriptionChange,
  onBodyFocus,
}: TitleZoneProps) {
  const descriptionRef = useRef<HTMLTextAreaElement>(null);
  const [isEditingDescription, setIsEditingDescription] = useState(false);
  const hasDescription = description.trim().length > 0;

  const resizeDescription = useCallback(() => {
    const node = descriptionRef.current;
    if (!node) return;
    node.style.height = "0px";
    node.style.height = `${node.scrollHeight}px`;
  }, []);

  useEffect(() => {
    resizeDescription();
  }, [description, resizeDescription]);

  const focusDescription = useCallback(() => {
    setIsEditingDescription(true);
    requestAnimationFrame(() => {
      const node = descriptionRef.current;
      if (!node) return;
      node.focus();
      const end = node.value.length;
      node.setSelectionRange(end, end);
    });
  }, []);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter") {
        e.preventDefault();
        focusDescription();
      }
    },
    [focusDescription],
  );

  const handleDescriptionKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter") {
        e.preventDefault();
        onBodyFocus();
      }
    },
    [onBodyFocus],
  );

  // Treat default "Untitled" as empty so it shows as placeholder
  const defaultTitle = m.editor_untitled();
  const isDefault = title === defaultTitle || title === "Untitled";
  const displayValue = isDefault ? "" : title;

  return (
    <div className="mb-1 flex items-center gap-3">
      <div className="flex shrink-0 items-center">
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
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <input
          type="text"
          value={displayValue}
          onChange={(e) => onTitleChange(e.target.value || defaultTitle)}
          onKeyDown={handleKeyDown}
          placeholder={defaultTitle}
          className="min-w-0 bg-transparent text-3xl font-bold outline-none placeholder:text-muted-foreground/40"
        />
        {hasDescription || isEditingDescription ? (
          <textarea
            ref={descriptionRef}
            value={description}
            rows={1}
            onChange={(e) => {
              onDescriptionChange(e.target.value.replace(/\n/g, " "));
              requestAnimationFrame(resizeDescription);
            }}
            onKeyDown={handleDescriptionKeyDown}
            onBlur={() => {
              if (!description.trim()) setIsEditingDescription(false);
            }}
            placeholder={m.editor_description_placeholder()}
            className={cn(
              "min-h-6 resize-none overflow-hidden bg-transparent text-base leading-6 text-muted-foreground outline-none",
              "placeholder:text-muted-foreground/40",
            )}
          />
        ) : (
          <button
            type="button"
            onClick={focusDescription}
            className="flex h-6 w-fit items-center rounded-sm px-1 text-base leading-6 text-muted-foreground/60 outline-none transition-colors hover:bg-muted hover:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            {m.editor_add_description()}
          </button>
        )}
      </div>
    </div>
  );
}
