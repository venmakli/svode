import { BasicNodesKit } from "@/components/editor/plugins/basic-nodes-kit";
import { AutoformatKit } from "@/components/editor/plugins/autoformat-kit";
import { ExitBreakKit } from "@/components/editor/plugins/exit-break-kit";
import { LinkKit } from "@/components/editor/plugins/link-kit";

import { CalloutPlugin } from "@platejs/callout/react";
import {
  CodeBlockPlugin,
  CodeLinePlugin,
  CodeSyntaxPlugin,
} from "@platejs/code-block/react";
import { DndPlugin } from "@platejs/dnd";
import { DndProvider } from "react-dnd";
import { HTML5Backend } from "react-dnd-html5-backend";
import { IndentPlugin } from "@platejs/indent/react";
import {
  BulletedListPlugin,
  ListItemPlugin,
  ListPlugin,
  NumberedListPlugin,
  TaskListPlugin,
} from "@platejs/list-classic/react";
import { MarkdownPlugin } from "@platejs/markdown";
import { BlockMenuPlugin, BlockSelectionPlugin } from "@platejs/selection/react";
import { SlashInputPlugin, SlashPlugin } from "@platejs/slash-command/react";
import {
  TablePlugin,
  TableRowPlugin,
  TableCellPlugin,
  TableCellHeaderPlugin,
} from "@platejs/table/react";
import { TocPlugin } from "@platejs/toc/react";
import { TogglePlugin } from "@platejs/toggle/react";
import { KEYS } from "platejs";
import remarkGfm from "remark-gfm";

import { CalloutElement } from "@/components/ui/callout-node";
import {
  CodeBlockElement,
  CodeLineElement,
  CodeSyntaxLeaf,
} from "@/components/ui/code-block-node";
import {
  BulletedListElement,
  ListItemElement,
  NumberedListElement,
  TaskListElement,
} from "@/components/ui/list-classic-node";
import {
  TableCellElement,
  TableCellHeaderElement,
  TableElement,
  TableRowElement,
} from "@/components/ui/table-node";
import { TocElement } from "@/components/ui/toc-node";
import { ToggleElement } from "@/components/ui/toggle-node";
import { BlockDraggable } from "@/components/ui/block-draggable";
import { SlashInputElement } from "./slash-input-element";

export function getPlugins() {
  return [
    // Basic nodes (headings, paragraph, blockquote, hr, marks)
    ...BasicNodesKit,

    // Link (with floating toolbar)
    ...LinkKit,

    // Lists (classic)
    ListPlugin,
    BulletedListPlugin.withComponent(BulletedListElement),
    NumberedListPlugin.withComponent(NumberedListElement),
    TaskListPlugin.withComponent(TaskListElement),
    ListItemPlugin.withComponent(ListItemElement),

    // Table
    TablePlugin.configure({
      node: { component: TableElement },
    }),
    TableRowPlugin.withComponent(TableRowElement),
    TableCellPlugin.withComponent(TableCellElement),
    TableCellHeaderPlugin.withComponent(TableCellHeaderElement),

    // Code block
    CodeBlockPlugin.configure({
      node: { component: CodeBlockElement },
    }),
    CodeLinePlugin.withComponent(CodeLineElement),
    CodeSyntaxPlugin.withComponent(CodeSyntaxLeaf),

    // Callout
    CalloutPlugin.withComponent(CalloutElement),

    // Toggle (collapsible blocks)
    TogglePlugin.withComponent(ToggleElement),

    // TOC (table of contents)
    TocPlugin.withComponent(TocElement),

    // Indent
    IndentPlugin.configure({
      inject: {
        targetPlugins: [
          ...KEYS.heading,
          KEYS.p,
          KEYS.blockquote,
          KEYS.codeBlock,
          KEYS.toggle,
        ],
      },
      options: {
        offset: 24,
      },
    }),

    // Block DnD
    DndPlugin.configure({
      options: {
        enableScroller: true,
      },
      render: {
        aboveNodes: BlockDraggable,
        aboveSlate: ({ children }) => (
          <DndProvider backend={HTML5Backend}>{children}</DndProvider>
        ),
      },
    }),

    // Block selection + context menu
    BlockSelectionPlugin,
    BlockMenuPlugin,

    // Autoformat (markdown shortcuts: # → heading, - → list, etc.)
    ...AutoformatKit,

    // Exit break (Cmd+Enter exits blocks)
    ...ExitBreakKit,

    // Markdown (serialize/deserialize)
    MarkdownPlugin.configure({
      options: {
        remarkPlugins: [remarkGfm],
      },
    }),

    // Slash commands
    SlashPlugin,
    SlashInputPlugin.withComponent(SlashInputElement),
  ];
}
