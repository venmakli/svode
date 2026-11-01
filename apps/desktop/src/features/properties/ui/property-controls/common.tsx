import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { colorStyle, optionColor, valueToString } from "../../lib/utils";
import type { PropertyOption } from "../../model/types";

export function deferStateUpdate(update: () => void) {
  let cancelled = false;
  queueMicrotask(() => {
    if (!cancelled) update();
  });
  return () => {
    cancelled = true;
  };
}

/**
 * The draft of a typed field of a property. It follows the saved value while
 * the field is not edited, so an update from disk does not reset an open
 * edit; Enter or leaving the field saves a changed draft, and Escape puts the
 * saved value back without saving.
 */
export function usePropertyTextDraft(
  value: unknown,
  commit: (draft: string) => void,
) {
  const saved = valueToString(value);
  const [draft, setDraft] = useState(saved);
  // The draft when editing began; null while the field is not edited.
  const editingRef = useRef<string | null>(null);
  const cancelRef = useRef(false);
  useEffect(
    () =>
      deferStateUpdate(() => {
        if (editingRef.current === null) setDraft(saved);
      }),
    [saved],
  );
  return {
    draft,
    setDraft,
    inputProps: {
      value: draft,
      onChange: (event: { target: { value: string } }) =>
        setDraft(event.target.value),
      onFocus: () => {
        editingRef.current = draft;
      },
      onBlur: () => {
        const started = editingRef.current;
        editingRef.current = null;
        if (cancelRef.current || started === null || draft === started) {
          cancelRef.current = false;
          setDraft(saved);
          return;
        }
        commit(draft);
      },
      onKeyDown: (event: KeyboardEvent<HTMLInputElement>) => {
        if (event.key === "Enter") event.currentTarget.blur();
        if (event.key === "Escape") {
          cancelRef.current = true;
          event.currentTarget.blur();
        }
      },
    },
  };
}

export function OptionDot({ option }: { option: PropertyOption }) {
  return (
    <span
      className="size-2 shrink-0 rounded-full bg-(--property-color)"
      style={colorStyle(optionColor(option))}
    />
  );
}

export function useAutoOpen(
  autoOpen: boolean | undefined,
  onOpenChange: ((open: boolean) => void) | undefined,
) {
  const [open, setOpen] = useState(Boolean(autoOpen));

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      setOpen(nextOpen);
      onOpenChange?.(nextOpen);
    },
    [onOpenChange],
  );

  return [open, handleOpenChange] as const;
}

export function IconAction({
  label,
  children,
  className,
  disabled,
  onClick,
}: {
  label: string;
  children: ReactNode;
  className?: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className={className}
            disabled={disabled}
            onMouseDown={(event) => event.preventDefault()}
            onClick={(event) => {
              event.preventDefault();
              onClick();
            }}
          >
            {children}
            <span className="sr-only">{label}</span>
          </Button>
        </TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
