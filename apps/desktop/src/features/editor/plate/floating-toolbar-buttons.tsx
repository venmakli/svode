import { useState, useCallback } from "react";
import {
  BoldPlugin,
  CodePlugin,
  HighlightPlugin,
  ItalicPlugin,
  StrikethroughPlugin,
  UnderlinePlugin,
} from "@platejs/basic-nodes/react";
import { FontColorPlugin } from "@platejs/basic-styles/react";
import { LinkPlugin, triggerFloatingLink } from "@platejs/link/react";
import {
  Bold,
  Italic,
  Strikethrough,
  Highlighter,
  Code,
  Link,
  Underline as UnderlineIcon,
} from "lucide-react";
import { useEditorRef } from "platejs/react";

import { MarkToolbarButton } from "@/components/ui/mark-toolbar-button";
import { ToolbarButton, ToolbarGroup, ToolbarSeparator } from "@/components/ui/toolbar";
import { FontColorToolbarButton } from "@/components/ui/font-color-toolbar-button";

export function FloatingToolbarButtons() {
  const editor = useEditorRef();

  return (
    <div className="flex items-center gap-0.5">
      <ToolbarGroup>
        <MarkToolbarButton nodeType={BoldPlugin.key} tooltip="Bold (⌘B)">
          <Bold className="size-4" />
        </MarkToolbarButton>
        <MarkToolbarButton nodeType={ItalicPlugin.key} tooltip="Italic (⌘I)">
          <Italic className="size-4" />
        </MarkToolbarButton>
        <MarkToolbarButton
          nodeType={StrikethroughPlugin.key}
          tooltip="Strikethrough (⌘⇧S)"
        >
          <Strikethrough className="size-4" />
        </MarkToolbarButton>
        <MarkToolbarButton
          nodeType={HighlightPlugin.key}
          tooltip="Highlight (⌘⇧H)"
        >
          <Highlighter className="size-4" />
        </MarkToolbarButton>
        <MarkToolbarButton nodeType={CodePlugin.key} tooltip="Code (⌘E)">
          <Code className="size-4" />
        </MarkToolbarButton>
        <MarkToolbarButton
          nodeType={UnderlinePlugin.key}
          tooltip="Underline (⌘U)"
        >
          <UnderlineIcon className="size-4" />
        </MarkToolbarButton>
      </ToolbarGroup>

      <ToolbarSeparator />

      <ToolbarGroup>
        <ToolbarButton
          tooltip="Link (⌘K)"
          onClick={() => triggerFloatingLink(editor, { focused: true })}
        >
          <Link className="size-4" />
        </ToolbarButton>
      </ToolbarGroup>

      <ToolbarSeparator />

      <ToolbarGroup>
        <FontColorToolbarButton nodeType="color" tooltip="Text color">
          <span className="font-bold text-xs">A</span>
        </FontColorToolbarButton>
      </ToolbarGroup>
    </div>
  );
}
