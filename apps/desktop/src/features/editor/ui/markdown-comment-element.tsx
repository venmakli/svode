import type { ReactNode } from "react";
import { LinkIcon, MessageSquareTextIcon, type LucideIcon } from "lucide-react";
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
import type {
  MarkdownCommentElement as TMarkdownCommentElement,
  MarkdownLinkDefinitionElement as TMarkdownLinkDefinitionElement,
} from "../model/markdown-comments";

function commentName(text: string): string {
  return text
    ? m.editor_markdown_comment_name({ text })
    : m.editor_markdown_comment();
}

/** Full marker text on hover; an empty comment has none to show. */
function MarkerTooltip({
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

interface MarkerProps<
  T extends TMarkdownCommentElement | TMarkdownLinkDefinitionElement,
> extends PlateElementProps<T> {
  icon: LucideIcon;
  label: string;
  name: string;
  text: string;
}

/** Block marker: a muted line with the start of its text. */
function BlockMarker<
  T extends TMarkdownCommentElement | TMarkdownLinkDefinitionElement,
>({ icon: Icon, label, name, text, ...props }: MarkerProps<T>) {
  const selected = useSelected();
  const focused = useFocused();

  return (
    <PlateElement {...props} className="py-0.5">
      <MarkerTooltip text={text}>
        <div
          contentEditable={false}
          role="note"
          aria-label={name}
          className={cn(
            "flex w-fit max-w-full min-w-0 items-center gap-1.5 rounded-sm text-sm text-muted-foreground select-none",
            selected && focused && "ring-2 ring-ring ring-offset-2",
          )}
        >
          <Icon aria-hidden className="size-3.5 shrink-0" />
          <span className="shrink-0">{label}</span>
          {text ? (
            <span className="truncate">{text.split("\n", 1)[0]}</span>
          ) : null}
        </div>
      </MarkerTooltip>
      {props.children}
    </PlateElement>
  );
}

/** Inline marker: a muted icon inside a line of text. */
function InlineMarker<
  T extends TMarkdownCommentElement | TMarkdownLinkDefinitionElement,
>({ icon: Icon, name, text, ...props }: Omit<MarkerProps<T>, "label">) {
  const selected = useSelected();
  const focused = useFocused();

  return (
    <PlateElement {...props} as="span">
      <MarkerTooltip text={text}>
        <span
          contentEditable={false}
          role="note"
          aria-label={name}
          className={cn(
            "mx-0.5 inline-flex items-center rounded-sm align-middle text-muted-foreground select-none",
            selected && focused && "ring-2 ring-ring",
          )}
        >
          <Icon aria-hidden className="size-3.5" />
        </span>
      </MarkerTooltip>
      {props.children}
    </PlateElement>
  );
}

/** Block Markdown comment. */
export function MarkdownCommentElement(
  props: PlateElementProps<TMarkdownCommentElement>,
) {
  const text = markdownCommentText(props.element.raw);
  return (
    <BlockMarker
      {...props}
      icon={MessageSquareTextIcon}
      label={m.editor_markdown_comment()}
      name={commentName(text)}
      text={text}
    />
  );
}

/** Inline Markdown comment. */
export function MarkdownInlineCommentElement(
  props: PlateElementProps<TMarkdownCommentElement>,
) {
  const text = markdownCommentText(props.element.raw);
  return (
    <InlineMarker
      {...props}
      icon={MessageSquareTextIcon}
      name={commentName(text)}
      text={text}
    />
  );
}

/** Link definition: its source text after the label. */
export function MarkdownLinkDefinitionElement(
  props: PlateElementProps<TMarkdownLinkDefinitionElement>,
) {
  const text = props.element.raw.trim();
  return (
    <BlockMarker
      {...props}
      icon={LinkIcon}
      label={m.editor_markdown_link_definition()}
      name={m.editor_markdown_link_definition_name({ text })}
      text={text}
    />
  );
}

/** Link definition that opens a list item. */
export function MarkdownInlineLinkDefinitionElement(
  props: PlateElementProps<TMarkdownLinkDefinitionElement>,
) {
  const text = props.element.raw.trim();
  return (
    <InlineMarker
      {...props}
      icon={LinkIcon}
      name={m.editor_markdown_link_definition_name({ text })}
      text={text}
    />
  );
}
