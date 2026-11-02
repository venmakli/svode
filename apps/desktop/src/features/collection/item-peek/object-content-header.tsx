import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { LoaderCircle } from "lucide-react";

import * as m from "@/paraglide/messages.js";

/**
 * Inline editing of the name and the description in the content header, as
 * in the page header. Each is saved at once — the name on Enter or when it
 * loses focus, the description likewise — through the owner, which rejects
 * with the reason a value was not saved. A refused value shows the saved one
 * and the reason under it; an empty name is not saved. Escape puts the saved
 * value back.
 */
export interface ObjectContentHeaderEdit {
  /** The saved description to edit; `description` of the header shows it otherwise. */
  description: string;
  /** Saves the name; rejects with the reason it was not saved. */
  onTitleCommit(title: string): Promise<void>;
  /** Saves the description; rejects with the reason it was not saved. */
  onDescriptionCommit(description: string): Promise<void>;
  /**
   * A new value focuses the name with its text selected, as after creating
   * the object; a screen that mounts with a value focuses it at once.
   */
  titleFocusRequest?: number;
}

/**
 * The content header of an object screen below the top bar, in the view of
 * the page header: the icon from the object's source or the fallback of its
 * kind, the name and a short description under it, both edited in place
 * where the owner declares it.
 */
export function ObjectContentHeader({
  description,
  edit,
  icon,
  title,
}: {
  description?: ReactNode;
  edit?: ObjectContentHeaderEdit;
  icon: ReactNode;
  title: string;
}) {
  return (
    <div className="flex min-w-0 items-start gap-3" data-object-content-header>
      <span
        className="flex size-9 shrink-0 items-center justify-center text-muted-foreground [&_svg]:size-6"
        aria-hidden
      >
        {icon}
      </span>
      {edit ? (
        <EditableObjectContentHeader edit={edit} title={title} />
      ) : (
        <div className="flex min-w-0 flex-1 flex-col">
          <p className="min-w-0 break-words text-[22px] font-bold leading-8 [overflow-wrap:anywhere]">
            {title}
          </p>
          {description ? (
            <p className="min-w-0 whitespace-pre-wrap break-words text-[13px] leading-5 text-muted-foreground [overflow-wrap:anywhere]">
              {description}
            </p>
          ) : null}
        </div>
      )}
    </div>
  );
}

function EditableObjectContentHeader({
  edit,
  title,
}: {
  edit: ObjectContentHeaderEdit;
  title: string;
}) {
  const titleRef = useRef<HTMLTextAreaElement>(null);
  const descriptionRef = useRef<HTMLTextAreaElement>(null);
  const titleErrorId = useId();
  const descriptionErrorId = useId();
  const [editingDescription, setEditingDescription] = useState(false);
  const titleField = useInlineField({
    saved: title,
    required: true,
    commit: edit.onTitleCommit,
  });
  const descriptionField = useInlineField({
    saved: edit.description,
    required: false,
    commit: edit.onDescriptionCommit,
  });

  const handledFocusRequestRef = useRef(0);
  const { titleFocusRequest = 0 } = edit;
  useEffect(() => {
    if (titleFocusRequest === handledFocusRequestRef.current) return;
    handledFocusRequestRef.current = titleFocusRequest;
    // After the overlay that opens the screen has placed its own focus.
    const frame = requestAnimationFrame(() => {
      const node = titleRef.current;
      if (!node) return;
      node.focus();
      node.select();
    });
    return () => cancelAnimationFrame(frame);
  }, [titleFocusRequest]);

  useAutoHeight(titleRef, titleField.draft);
  useAutoHeight(descriptionRef, descriptionField.draft);

  const showDescription =
    editingDescription ||
    descriptionField.draft.length > 0 ||
    descriptionField.message !== null;

  const focusDescription = () => {
    setEditingDescription(true);
    requestAnimationFrame(() => {
      const node = descriptionRef.current;
      if (!node) return;
      node.focus();
      const end = node.value.length;
      node.setSelectionRange(end, end);
    });
  };

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <div className="flex min-w-0 items-start gap-1.5">
        <textarea
          ref={titleRef}
          rows={1}
          value={titleField.draft}
          readOnly={titleField.pending}
          aria-label={m.object_header_title_label()}
          aria-invalid={titleField.message ? true : undefined}
          aria-describedby={titleField.message ? titleErrorId : undefined}
          aria-busy={titleField.pending || undefined}
          data-object-content-header-title
          className="min-w-0 flex-1 resize-none overflow-hidden bg-transparent text-[22px] font-bold leading-8 outline-none [overflow-wrap:anywhere]"
          onFocus={titleField.onFocus}
          onChange={(event) =>
            titleField.change(event.target.value.replace(/\n/g, " "))
          }
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              titleField.cancel();
              event.currentTarget.blur();
              return;
            }
            if (event.key === "Enter") {
              event.preventDefault();
              event.currentTarget.blur();
            }
          }}
          onBlur={titleField.onBlur}
        />
        {titleField.pending ? <SavingIndicator /> : null}
      </div>
      {titleField.message ? (
        <span
          id={titleErrorId}
          role="alert"
          className="text-xs text-destructive"
          data-object-content-header-message="title"
        >
          {titleField.message}
        </span>
      ) : null}
      {showDescription ? (
        <div className="flex min-w-0 items-start gap-1.5">
          <textarea
            ref={descriptionRef}
            rows={1}
            value={descriptionField.draft}
            readOnly={descriptionField.pending}
            aria-label={m.editor_description_placeholder()}
            aria-invalid={descriptionField.message ? true : undefined}
            aria-describedby={
              descriptionField.message ? descriptionErrorId : undefined
            }
            aria-busy={descriptionField.pending || undefined}
            placeholder={m.editor_description_placeholder()}
            data-object-content-header-description
            className="min-h-5 min-w-0 flex-1 resize-none overflow-hidden bg-transparent text-[13px] leading-5 text-muted-foreground outline-none placeholder:text-muted-foreground/40 [overflow-wrap:anywhere]"
            onFocus={descriptionField.onFocus}
            onChange={(event) =>
              descriptionField.change(event.target.value.replace(/\n/g, " "))
            }
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                descriptionField.cancel();
                event.currentTarget.blur();
                return;
              }
              if (event.key === "Enter") {
                event.preventDefault();
                event.currentTarget.blur();
              }
            }}
            onBlur={() => {
              descriptionField.onBlur();
              setEditingDescription(false);
            }}
          />
          {descriptionField.pending ? <SavingIndicator /> : null}
        </div>
      ) : (
        <button
          type="button"
          onClick={focusDescription}
          className="flex h-5 w-fit items-center rounded-sm px-1 text-[13px] leading-5 text-muted-foreground/60 outline-none transition-colors hover:bg-muted hover:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          {m.editor_add_description()}
        </button>
      )}
      {descriptionField.message ? (
        <span
          id={descriptionErrorId}
          role="alert"
          className="text-xs text-destructive"
          data-object-content-header-message="description"
        >
          {descriptionField.message}
        </span>
      ) : null}
    </div>
  );
}

function SavingIndicator() {
  return (
    <LoaderCircle
      className="mt-1 size-3.5 shrink-0 animate-spin text-muted-foreground"
      aria-label={m.property_saving()}
      data-object-content-header-pending
    />
  );
}

/**
 * The draft of one inline field: it follows the saved value while the field
 * is not edited, and on leaving the field saves a changed draft through the
 * owner, which may refuse it.
 */
function useInlineField({
  commit,
  required,
  saved,
}: {
  commit(value: string): Promise<void>;
  required: boolean;
  saved: string;
}) {
  const [draft, setDraft] = useState(saved);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const focusedRef = useRef(false);
  const cancelledRef = useRef(false);
  const pendingRef = useRef(false);

  const [shownSaved, setShownSaved] = useState(saved);
  if (shownSaved !== saved) {
    setShownSaved(saved);
    if (!focusedRef.current && !pendingRef.current) setDraft(saved);
  }

  const save = useCallback(
    async (value: string) => {
      const next = value.trim();
      if (next === saved.trim()) {
        setDraft(saved);
        return;
      }
      if (required && !next) {
        setDraft(saved);
        setMessage(m.object_header_title_required());
        return;
      }
      pendingRef.current = true;
      setPending(true);
      setMessage(null);
      try {
        await commit(next);
        setDraft(next);
      } catch (error) {
        setDraft(saved);
        setMessage(
          error instanceof Error && error.message
            ? error.message
            : m.property_write_failed(),
        );
      } finally {
        pendingRef.current = false;
        setPending(false);
      }
    },
    [commit, required, saved],
  );

  return {
    draft,
    message,
    pending,
    change(value: string) {
      setDraft(value);
      setMessage(null);
    },
    cancel() {
      cancelledRef.current = true;
      setDraft(saved);
      setMessage(null);
    },
    onFocus() {
      focusedRef.current = true;
    },
    onBlur() {
      focusedRef.current = false;
      if (cancelledRef.current) {
        cancelledRef.current = false;
        return;
      }
      if (pendingRef.current) return;
      void save(draft);
    },
  };
}

function useAutoHeight(
  ref: RefObject<HTMLTextAreaElement | null>,
  value: string,
) {
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    node.style.height = "0px";
    node.style.height = `${node.scrollHeight}px`;
  }, [ref, value]);
}

/**
 * Whether Escape in `target` belongs to an inline edit of the content header,
 * which it cancels, rather than to the overlay around the screen.
 */
export function keepsObjectContentHeaderEditOnEscape(
  target: EventTarget | null,
): boolean {
  const element = target as Element | null;
  if (!element || typeof element.closest !== "function") return false;
  return (
    element.tagName === "TEXTAREA" &&
    element.closest("[data-object-content-header]") !== null
  );
}
