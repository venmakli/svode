"use client";

import { LinkPlugin } from "@platejs/link/react";
import { MentionInputPlugin, MentionPlugin } from "@platejs/mention/react";
import { type Value, KEYS, TrailingBlockPlugin } from "platejs";
import { type TPlateEditor, useEditorRef } from "platejs/react";

import {
  ENABLE_PLATE_ADVANCED_BLOCKS,
  ENABLE_PLATE_AI,
  ENABLE_PLATE_REVIEW,
} from "@/shared/config/plate-feature-flags";
import { AIKit } from "@/components/editor/plugins/ai-kit";
import { AlignKit } from "@/components/editor/plugins/align-kit";
import { AutoformatKit } from "@/components/editor/plugins/autoformat-kit";
import { BasicBlocksKit } from "@/components/editor/plugins/basic-blocks-kit";
import { BasicMarksKit } from "@/components/editor/plugins/basic-marks-kit";
import { BlockMenuKit } from "@/components/editor/plugins/block-menu-kit";
import { BlockPlaceholderKit } from "@/components/editor/plugins/block-placeholder-kit";
import { CalloutKit } from "@/components/editor/plugins/callout-kit";
import { CodeBlockKit } from "@/components/editor/plugins/code-block-kit";
import { ColumnKit } from "@/components/editor/plugins/column-kit";
import { CommentKit } from "@/components/editor/plugins/comment-kit";
import { CopilotKit } from "@/components/editor/plugins/copilot-kit";
import { CursorOverlayKit } from "@/components/editor/plugins/cursor-overlay-kit";
import { DateKit } from "@/components/editor/plugins/date-kit";
import { DiscussionKit } from "@/components/editor/plugins/discussion-kit";
import { DndKit } from "@/components/editor/plugins/dnd-kit";
import { DocxKit } from "@/components/editor/plugins/docx-kit";
import { EmojiKit } from "@/components/editor/plugins/emoji-kit";
import { ExitBreakKit } from "@/components/editor/plugins/exit-break-kit";
import { FloatingToolbarKit } from "@/components/editor/plugins/floating-toolbar-kit";
import { FontKit } from "@/components/editor/plugins/font-kit";
import { LineHeightKit } from "@/components/editor/plugins/line-height-kit";
import { ListKit } from "@/components/editor/plugins/list-kit";
import { MarkdownKit } from "@/components/editor/plugins/markdown-kit";
import { MathKit } from "@/components/editor/plugins/math-kit";
import { MediaKit } from "@/components/editor/plugins/media-kit";
import { SlashKit } from "@/components/editor/plugins/slash-kit";
import { SuggestionKit } from "@/components/editor/plugins/suggestion-kit";
import { TableKit } from "@/components/editor/plugins/table-kit";
import { TocKit } from "@/components/editor/plugins/toc-kit";
import { ToggleKit } from "@/components/editor/plugins/toggle-kit";
import { MentionElement } from "@/components/ui/mention-node";
import { ConflictPlugin } from "../conflict/conflict-plugin";
import {
  MARKDOWN_COMMENT_KEY,
  MARKDOWN_LINK_DEFINITION_KEY,
  markdownCommentRules,
  remarkMarkdownComments,
  serializeMarkdownWithComments,
} from "../model/markdown-comments";
import { deserializeEditorMarkdownSegment } from "../model/markdown-io";
import {
  markdownLineBreakRules,
  remarkBreakLineEndings,
  withListLineBreaks,
} from "../model/markdown-line-breaks";
import {
  markdownInlineImageRules,
  remarkInlineImages,
} from "../model/markdown-inline-image";
import { markdownLinkRules } from "../model/markdown-link";
import { markdownParagraphRules } from "../model/markdown-paragraph";
import { markdownImageReferenceRules } from "../model/markdown-references";
import {
  TRAILING_BLOCK_MARK,
  withoutServiceTrailingBlock,
} from "../model/trailing-block";
import { BrokenLinksPlugin } from "./broken-links-plugin";
import { InlineImagePlugin } from "./inline-image-plugin";
import { MarkdownCommentKit } from "./markdown-comment-kit";
import { SystemDictationPlugin } from "./system-dictation-plugin";
import { LinkShortcutPlugin } from "./link-shortcut-plugin";
import { SoftLineBreakPlugin } from "./soft-line-break-plugin";
import { PageLinkElement } from "../ui/page-link-element";
import { PageLinkInputElement } from "../ui/page-link-input-element";
import { FloatingToolbar } from "@/components/ui/floating-toolbar";
import { FloatingToolbarButtons } from "./floating-toolbar-buttons";
import { PageLinkFloatingToolbar } from "../ui/page-link-toolbar";

const ProductLinkKit = [
  LinkPlugin.configure({
    // ⌘K is LinkShortcutPlugin's: a link or Search, never both.
    options: { triggerFloatingLinkHotkeys: "" },
    render: {
      node: PageLinkElement,
      afterEditable: () => <PageLinkFloatingToolbar />,
    },
  }),
  BrokenLinksPlugin,
  LinkShortcutPlugin,
];

const ProductMentionKit = [
  MentionPlugin.configure({
    options: {
      triggerPreviousCharPattern: /^$|^[\s"']$/,
    },
  }).withComponent(MentionElement),
  MentionInputPlugin.withComponent(PageLinkInputElement),
];

// Every Markdown → editor value path goes through the editor Markdown
// boundary, pasted plain text included.
const ProductMarkdownKit = MarkdownKit.map((plugin) =>
  plugin
    .extendApi(({ editor }) => ({
      serialize: (
        options?: Parameters<typeof serializeMarkdownWithComments>[1],
      ) =>
        serializeMarkdownWithComments(editor, {
          ...options,
          value: withListLineBreaks(
            editor,
            withoutServiceTrailingBlock(
              editor,
              options?.value ?? editor.children,
            ),
          ),
        }),
    }))
    .extend(({ getOptions }) => ({
      options: {
        remarkPlugins: [
          ...getOptions().remarkPlugins,
          remarkMarkdownComments,
          remarkBreakLineEndings,
          remarkInlineImages,
        ],
        rules: {
          ...getOptions().rules,
          ...markdownLineBreakRules,
          ...markdownLinkRules,
          ...markdownParagraphRules,
          ...markdownCommentRules,
          ...markdownInlineImageRules,
          ...markdownImageReferenceRules,
        },
      },
      parser: {
        deserialize: ({ data, editor }) =>
          deserializeEditorMarkdownSegment(editor, data),
      },
    })),
);

// The trailing paragraph carries its mark until it is split: the half after
// the split point is a paragraph the user made.
const ProductTrailingBlockPlugin = TrailingBlockPlugin.configure({
  options: {
    insert: (editor, { at, type }) => {
      editor.tf.insertNodes(
        editor.api.create.block({ type, [TRAILING_BLOCK_MARK]: true }, at),
        { at },
      );
    },
  },
}).overrideEditor(({ tf: { apply } }) => ({
  transforms: {
    apply(operation) {
      if (
        operation.type === "split_node" &&
        TRAILING_BLOCK_MARK in operation.properties
      ) {
        const { [TRAILING_BLOCK_MARK]: _mark, ...properties } =
          operation.properties;
        apply({ ...operation, properties });
        return;
      }
      apply(operation);
    },
  },
}));

// A block comment or link definition inside a list item keeps the item's
// indent.
const ProductListKit = ListKit.map((plugin) =>
  plugin.key === KEYS.indent
    ? plugin.extend(({ plugin: { inject } }) => ({
        inject: {
          targetPlugins: [
            ...(inject.targetPlugins ?? []),
            MARKDOWN_COMMENT_KEY,
            MARKDOWN_LINK_DEFINITION_KEY,
          ],
        },
      }))
    : plugin,
);

export const EditorKit = [
  ...(ENABLE_PLATE_AI ? [...CopilotKit, ...AIKit] : []),

  ...BasicBlocksKit,
  ...CodeBlockKit,
  ...TableKit,
  ...ToggleKit,
  ...MediaKit,
  InlineImagePlugin,
  ...CalloutKit,
  ...(ENABLE_PLATE_ADVANCED_BLOCKS ? TocKit : []),
  ...(ENABLE_PLATE_ADVANCED_BLOCKS ? ColumnKit : []),
  ...(ENABLE_PLATE_ADVANCED_BLOCKS ? MathKit : []),
  ...DateKit,
  ...ProductLinkKit,
  ...ProductMentionKit,

  ...BasicMarksKit,
  ...FontKit,

  ...ProductListKit,
  ...AlignKit,
  ...LineHeightKit,

  ...(ENABLE_PLATE_REVIEW ? DiscussionKit : []),
  ...(ENABLE_PLATE_REVIEW ? CommentKit : []),
  ...(ENABLE_PLATE_REVIEW ? SuggestionKit : []),

  ...SlashKit,
  ...AutoformatKit,
  ...CursorOverlayKit,
  ...BlockMenuKit,
  ...DndKit,
  ...EmojiKit,
  ...ExitBreakKit,
  ProductTrailingBlockPlugin,
  SoftLineBreakPlugin,
  SystemDictationPlugin,

  ConflictPlugin,
  ...MarkdownCommentKit,

  ...DocxKit,
  ...ProductMarkdownKit,

  ...BlockPlaceholderKit,
  ...FloatingToolbarKit.map((plugin) =>
    plugin.configure({
      render: {
        afterEditable: () => (
          <FloatingToolbar>
            <FloatingToolbarButtons />
          </FloatingToolbar>
        ),
      },
    }),
  ),
];

export type MyEditor = TPlateEditor<Value, (typeof EditorKit)[number]>;

export const useEditor = () => useEditorRef<MyEditor>();
