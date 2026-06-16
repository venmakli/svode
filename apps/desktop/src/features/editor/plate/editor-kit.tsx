'use client';

import { LinkPlugin } from '@platejs/link/react';
import { MentionInputPlugin, MentionPlugin } from '@platejs/mention/react';
import { type Value, TrailingBlockPlugin } from 'platejs';
import { type TPlateEditor, useEditorRef } from 'platejs/react';

import {
  ENABLE_PLATE_ADVANCED_BLOCKS,
  ENABLE_PLATE_AI,
  ENABLE_PLATE_REVIEW,
} from '@/app/config/feature-flags';
import { AIKit } from '@/components/editor/plugins/ai-kit';
import { AlignKit } from '@/components/editor/plugins/align-kit';
import { AutoformatKit } from '@/components/editor/plugins/autoformat-kit';
import { BasicBlocksKit } from '@/components/editor/plugins/basic-blocks-kit';
import { BasicMarksKit } from '@/components/editor/plugins/basic-marks-kit';
import { BlockMenuKit } from '@/components/editor/plugins/block-menu-kit';
import { BlockPlaceholderKit } from '@/components/editor/plugins/block-placeholder-kit';
import { CalloutKit } from '@/components/editor/plugins/callout-kit';
import { CodeBlockKit } from '@/components/editor/plugins/code-block-kit';
import { ColumnKit } from '@/components/editor/plugins/column-kit';
import { CommentKit } from '@/components/editor/plugins/comment-kit';
import { CopilotKit } from '@/components/editor/plugins/copilot-kit';
import { CursorOverlayKit } from '@/components/editor/plugins/cursor-overlay-kit';
import { DateKit } from '@/components/editor/plugins/date-kit';
import { DiscussionKit } from '@/components/editor/plugins/discussion-kit';
import { DndKit } from '@/components/editor/plugins/dnd-kit';
import { DocxKit } from '@/components/editor/plugins/docx-kit';
import { EmojiKit } from '@/components/editor/plugins/emoji-kit';
import { ExitBreakKit } from '@/components/editor/plugins/exit-break-kit';
import { FixedToolbarKit } from '@/components/editor/plugins/fixed-toolbar-kit';
import { FloatingToolbarKit } from '@/components/editor/plugins/floating-toolbar-kit';
import { FontKit } from '@/components/editor/plugins/font-kit';
import { LineHeightKit } from '@/components/editor/plugins/line-height-kit';
import { ListKit } from '@/components/editor/plugins/list-kit';
import { MarkdownKit } from '@/components/editor/plugins/markdown-kit';
import { MathKit } from '@/components/editor/plugins/math-kit';
import { MediaKit } from '@/components/editor/plugins/media-kit';
import { SlashKit } from '@/components/editor/plugins/slash-kit';
import { SuggestionKit } from '@/components/editor/plugins/suggestion-kit';
import { TableKit } from '@/components/editor/plugins/table-kit';
import { TocKit } from '@/components/editor/plugins/toc-kit';
import { ToggleKit } from '@/components/editor/plugins/toggle-kit';
import { MentionElement } from '@/components/ui/mention-node';
import { ConflictPlugin } from '../conflict/conflict-plugin';
import { DocLinkElement } from '../doc-link-element';
import { DocLinkInputElement } from '../doc-link-input-element';
import { DocLinkFloatingToolbar } from '../doc-link-toolbar';

const ProductLinkKit = [
  LinkPlugin.configure({
    render: {
      node: DocLinkElement,
      afterEditable: () => <DocLinkFloatingToolbar />,
    },
  }),
];

const ProductMentionKit = [
  MentionPlugin.configure({
    options: {
      triggerPreviousCharPattern: /^$|^[\s"']$/,
    },
  }).withComponent(MentionElement),
  MentionInputPlugin.withComponent(DocLinkInputElement),
];

export const EditorKit = [
  ...(ENABLE_PLATE_AI ? [...CopilotKit, ...AIKit] : []),

  ...BasicBlocksKit,
  ...CodeBlockKit,
  ...TableKit,
  ...ToggleKit,
  ...MediaKit,
  ...CalloutKit,
  ...(ENABLE_PLATE_ADVANCED_BLOCKS ? TocKit : []),
  ...(ENABLE_PLATE_ADVANCED_BLOCKS ? ColumnKit : []),
  ...(ENABLE_PLATE_ADVANCED_BLOCKS ? MathKit : []),
  ...DateKit,
  ...ProductLinkKit,
  ...ProductMentionKit,

  ...BasicMarksKit,
  ...FontKit,

  ...ListKit,
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
  TrailingBlockPlugin,

  ConflictPlugin,

  ...DocxKit,
  ...MarkdownKit,

  ...BlockPlaceholderKit,
  ...FloatingToolbarKit,
];

export type MyEditor = TPlateEditor<Value, (typeof EditorKit)[number]>;

export const useEditor = () => useEditorRef<MyEditor>();
