import type { ReactNode } from "react";
import { MessageSquareTextIcon } from "lucide-react";
import {
  PlateElement,
  type PlateElementProps,
  useFocused,
  useSelected,
} from "platejs/react";

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import * as m from "@/paraglide/messages.js";
import { cn } from "@/shared/lib/utils";

import { markdownCommentText } from "../lib/markdown-comment-text";
import type { MarkdownCommentElement as TMarkdownCommentElement } from "../model/markdown-comments";

function commentName(text: string): string {
  return text
    ? m.editor_markdown_comment_name({ text })
    : m.editor_markdown_comment();
}

/** Full comment text on hover; an empty comment has none to show. */
function CommentTooltip({
  text,
  children,
}: {
  text: string;
  children: ReactNode;
}) {
  if (!text) return children;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="bottom" align="start">
        <div className="max-h-64 overflow-y-auto break-words whitespace-pre-wrap">
          {text}
        </div>
      </TooltipContent>
    </Tooltip>
  );
}

/** Block Markdown comment: a muted line with the start of its text. */
export function MarkdownCommentElement(
  props: PlateElementProps<TMarkdownCommentElement>,
) {
  const selected = useSelected();
  const focused = useFocused();
  const text = markdownCommentText(props.element.raw);

  return (
    <PlateElement {...props} className="py-0.5">
      <CommentTooltip text={text}>
        <div
          contentEditable={false}
          role="note"
          aria-label={commentName(text)}
          className={cn(
            "flex w-fit max-w-full min-w-0 items-center gap-1.5 rounded-sm text-sm text-muted-foreground select-none",
            selected && focused && "ring-2 ring-ring ring-offset-2",
          )}
        >
          <MessageSquareTextIcon aria-hidden className="size-3.5 shrink-0" />
          <span className="shrink-0">{m.editor_markdown_comment()}</span>
          {text ? (
            <span className="truncate">{text.split("\n", 1)[0]}</span>
          ) : null}
        </div>
      </CommentTooltip>
      {props.children}
    </PlateElement>
  );
}

/** Inline Markdown comment: a muted icon inside a line of text. */
export function MarkdownInlineCommentElement(
  props: PlateElementProps<TMarkdownCommentElement>,
) {
  const selected = useSelected();
  const focused = useFocused();
  const text = markdownCommentText(props.element.raw);

  return (
    <PlateElement {...props} as="span">
      <CommentTooltip text={text}>
        <span
          contentEditable={false}
          role="note"
          aria-label={commentName(text)}
          className={cn(
            "mx-0.5 inline-flex items-center rounded-sm align-middle text-muted-foreground select-none",
            selected && focused && "ring-2 ring-ring",
          )}
        >
          <MessageSquareTextIcon aria-hidden className="size-3.5" />
        </span>
      </CommentTooltip>
      {props.children}
    </PlateElement>
  );
}
