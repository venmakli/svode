import type { DiffOperation } from "@platejs/diff";
import { LinkIcon, MessageSquareTextIcon, type LucideIcon } from "lucide-react";
import {
  createSlatePlugin,
  KEYS,
  type RenderStaticNodeWrapper,
  type TElement,
  type Value,
} from "platejs";
import {
  createStaticEditor,
  PlateStatic,
  SlateElement,
  type SlateElementProps,
  SlateLeaf,
  type SlateLeafProps,
} from "platejs/static";
import { type MouseEvent, useMemo } from "react";

import { BaseEditorKit } from "@/components/editor/editor-base-kit";
import { useResolvedMediaUrl } from "@/components/ui/media-adapter";
import * as m from "@/paraglide/messages.js";
import { cn } from "@/shared/lib/utils";

import { markdownCommentText } from "../lib/markdown-comment-text";
import {
  MARKDOWN_COMMENT_KEY,
  MARKDOWN_INLINE_COMMENT_KEY,
  MARKDOWN_INLINE_LINK_DEFINITION_KEY,
  MARKDOWN_LINK_DEFINITION_KEY,
} from "../model/markdown-comments";
import { INLINE_IMAGE_KEY } from "../model/markdown-inline-image";

const DIFF_TAG = { insert: "ins", delete: "del", update: "span" } as const;

/**
 * Marks in the tones of the lane (DF-293 R5): an insertion in the stronger
 * tone of its side, a deletion in red struck through, a change of format
 * underlined with dots.
 */
const DIFF_CLASS: Record<DiffOperation["type"], string> = {
  insert: "rounded-[2px] bg-(--conflict-lane-insert) no-underline",
  delete: "text-(--conflict-delete) line-through decoration-[1.5px]",
  update: "underline decoration-dotted underline-offset-3",
};

function DiffLeafStatic(props: SlateLeafProps) {
  const { type } = props.leaf.diffOperation as DiffOperation;
  return (
    <SlateLeaf
      {...props}
      as={DIFF_TAG[type]}
      attributes={{ ...props.attributes, "data-diff": type }}
      className={DIFF_CLASS[type]}
    >
      {props.children}
    </SlateLeaf>
  );
}

const diffAboveNodes: RenderStaticNodeWrapper =
  ({ editor, element }) =>
  ({ children }) => {
    if (!element.diff) return children;
    const { type } = element.diffOperation as DiffOperation;
    const Tag = DIFF_TAG[type];
    return (
      <Tag
        data-diff={type}
        className={cn(
          !editor.api.isInline(element) && "block rounded-sm",
          DIFF_CLASS[type],
        )}
      >
        {children}
      </Tag>
    );
  };

/** Shows the insertions, deletions and updates `computeDiff` marks. */
const ConflictDiffPlugin = createSlatePlugin({
  key: "diff",
  node: { isLeaf: true },
  render: { aboveNodes: diffAboveNodes },
}).withComponent(DiffLeafStatic);

type ImageElement = TElement & { url?: string; alt?: string };

function ImageStatic(props: SlateElementProps<ImageElement>) {
  const { url, alt } = props.element;
  const resolved = useResolvedMediaUrl(url);
  const inline = props.editor.api.isInline(props.element);
  return (
    <SlateElement {...props} as={inline ? "span" : "div"}>
      {resolved ? (
        <img
          src={resolved}
          alt={alt ?? ""}
          className={
            inline
              ? "inline-block h-[1lh] w-auto align-middle"
              : "my-2 max-w-full rounded-sm"
          }
        />
      ) : (
        <span className="text-muted-foreground">{alt}</span>
      )}
      {props.children}
    </SlateElement>
  );
}

function markerOf(element: TElement): {
  icon: LucideIcon;
  label: string;
  text: string;
} {
  const raw = String(element.raw ?? "");
  return element.type === MARKDOWN_COMMENT_KEY ||
    element.type === MARKDOWN_INLINE_COMMENT_KEY
    ? {
        icon: MessageSquareTextIcon,
        label: m.editor_markdown_comment(),
        text: markdownCommentText(raw),
      }
    : {
        icon: LinkIcon,
        label: m.editor_markdown_link_definition(),
        text: raw.trim(),
      };
}

/** A Markdown comment or link definition: a muted line like in the editor. */
function MarkerStatic(props: SlateElementProps) {
  const { icon: Icon, label, text } = markerOf(props.element);
  if (props.editor.api.isInline(props.element)) {
    return (
      <SlateElement
        {...props}
        as="span"
        className="mx-0.5 inline-flex items-center align-middle text-muted-foreground"
      >
        <Icon aria-hidden className="size-3.5" />
        {props.children}
      </SlateElement>
    );
  }
  return (
    <SlateElement
      {...props}
      className="flex min-w-0 items-center gap-1.5 py-0.5 text-sm text-muted-foreground"
    >
      <Icon aria-hidden className="size-3.5 shrink-0" />
      <span className="shrink-0">{label}</span>
      {text ? <span className="truncate">{text.split("\n", 1)[0]}</span> : null}
      {props.children}
    </SlateElement>
  );
}

const voidElement = (key: string, isInline: boolean) =>
  createSlatePlugin({
    key,
    node: { isElement: true, isInline, isVoid: true },
  });

/**
 * The plugins that render a conflict side as the editor shows a Page, the
 * nodes of Svode's Markdown included, with the marks of its differences.
 */
const ConflictSideKit = [
  ...BaseEditorKit.map((plugin) =>
    plugin.key === KEYS.img ? plugin.withComponent(ImageStatic) : plugin,
  ),
  voidElement(INLINE_IMAGE_KEY, true).withComponent(ImageStatic),
  voidElement(MARKDOWN_COMMENT_KEY, false).withComponent(MarkerStatic),
  voidElement(MARKDOWN_INLINE_COMMENT_KEY, true).withComponent(MarkerStatic),
  voidElement(MARKDOWN_LINK_DEFINITION_KEY, false).withComponent(MarkerStatic),
  voidElement(MARKDOWN_INLINE_LINK_DEFINITION_KEY, true).withComponent(
    MarkerStatic,
  ),
  ConflictDiffPlugin,
];

// A link in a side is shown, not followed: it would navigate the window.
function keepLinks(event: MouseEvent) {
  if ((event.target as Element).closest("a")) event.preventDefault();
}

/**
 * A conflict side, read only: its text rendered as the editor renders it,
 * with insertions and deletions marked.
 */
export function ConflictSideView({ value }: { value: Value }) {
  const editor = useMemo(
    () => createStaticEditor({ plugins: ConflictSideKit, value }),
    [value],
  );
  return (
    <div onClickCapture={keepLinks}>
      <PlateStatic editor={editor} className="text-base" />
    </div>
  );
}
