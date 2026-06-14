import {
  useRef,
  useCallback,
  useEffect,
  useState,
  type KeyboardEvent,
} from "react";
import { SmilePlus, type LucideIcon } from "lucide-react";
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
  readOnly?: boolean;
  hideDescription?: boolean;
  fallbackIcon?: LucideIcon;
  onActivateIdentity?: () => void;
}

export function TitleZone({
  title,
  icon,
  description,
  onTitleChange,
  onIconChange,
  onDescriptionChange,
  onBodyFocus,
  readOnly = false,
  hideDescription = false,
  fallbackIcon: FallbackIcon,
  onActivateIdentity,
}: TitleZoneProps) {
  const descriptionRef = useRef<HTMLTextAreaElement>(null);
  const isTitleFocusedRef = useRef(false);
  const isDescriptionFocusedRef = useRef(false);
  const [isEditingDescription, setIsEditingDescription] = useState(false);
  const canShowDescription = !hideDescription;
  // Treat default "Untitled" as empty so it shows as placeholder
  const defaultTitle = m.editor_untitled();
  const isDefault = title === defaultTitle || title === "Untitled";
  const displayValue = isDefault ? "" : title;
  const [titleDraft, setTitleDraft] = useState(displayValue);
  const [descriptionDraft, setDescriptionDraft] = useState(description);
  const hasDescription = descriptionDraft.trim().length > 0;

  useEffect(() => {
    if (!isTitleFocusedRef.current) {
      setTitleDraft(displayValue);
    }
  }, [displayValue]);

  useEffect(() => {
    if (!isDescriptionFocusedRef.current) {
      setDescriptionDraft(description);
    }
  }, [description]);

  const resizeDescription = useCallback(() => {
    const node = descriptionRef.current;
    if (!node) return;
    node.style.height = "0px";
    node.style.height = `${node.scrollHeight}px`;
  }, []);

  useEffect(() => {
    resizeDescription();
  }, [descriptionDraft, resizeDescription]);

  const focusDescription = useCallback(() => {
    if (readOnly) {
      onActivateIdentity?.();
      return;
    }
    setIsEditingDescription(true);
    requestAnimationFrame(() => {
      const node = descriptionRef.current;
      if (!node) return;
      node.focus();
      const end = node.value.length;
      node.setSelectionRange(end, end);
    });
  }, [onActivateIdentity, readOnly]);

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

  return (
    <div className="mb-1 flex items-center gap-3">
      <div className="flex shrink-0 items-center">
        {icon ? (
          <EmojiPicker value={icon} onChange={onIconChange} size="md" />
        ) : FallbackIcon ? (
          <button
            type="button"
            className="flex size-9 items-center justify-center rounded-md text-muted-foreground hover:bg-muted"
            onClick={onActivateIdentity}
          >
            <FallbackIcon />
          </button>
        ) : (
          <EmojiPicker
            value=""
            onChange={onIconChange}
            size="md"
            placeholder={
              <SmilePlus className="size-6 text-muted-foreground/40" />
            }
          />
        )}
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
        <input
          type="text"
          value={titleDraft}
          readOnly={readOnly}
          onFocus={
            readOnly
              ? onActivateIdentity
              : () => {
                  isTitleFocusedRef.current = true;
                }
          }
          onBlur={() => {
            isTitleFocusedRef.current = false;
          }}
          onClick={readOnly ? onActivateIdentity : undefined}
          onChange={(e) => {
            const next = e.target.value;
            setTitleDraft(next);
            onTitleChange(next || defaultTitle);
          }}
          onKeyDown={handleKeyDown}
          placeholder={defaultTitle}
          className="min-w-0 bg-transparent text-[22px] font-bold leading-8 outline-none placeholder:text-muted-foreground/40"
        />
        {canShowDescription && (hasDescription || isEditingDescription) ? (
          <textarea
            ref={descriptionRef}
            value={descriptionDraft}
            rows={1}
            onFocus={() => {
              isDescriptionFocusedRef.current = true;
            }}
            onChange={(e) => {
              const next = e.target.value.replace(/\n/g, " ");
              setDescriptionDraft(next);
              onDescriptionChange(next);
              requestAnimationFrame(resizeDescription);
            }}
            onKeyDown={handleDescriptionKeyDown}
            onBlur={() => {
              isDescriptionFocusedRef.current = false;
              if (!descriptionDraft.trim()) setIsEditingDescription(false);
            }}
            placeholder={m.editor_description_placeholder()}
            className={cn(
              "min-h-5 resize-none overflow-hidden bg-transparent text-[13px] leading-5 text-muted-foreground outline-none",
              "placeholder:text-muted-foreground/40",
            )}
          />
        ) : canShowDescription ? (
          <button
            type="button"
            onClick={focusDescription}
            className="flex h-5 w-fit items-center rounded-sm px-1 text-[13px] leading-5 text-muted-foreground/60 outline-none transition-colors hover:bg-muted hover:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            {m.editor_add_description()}
          </button>
        ) : null}
      </div>
    </div>
  );
}
