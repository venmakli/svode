"use client";

import * as React from "react";

import {
  BoldIcon,
  Code2Icon,
  ItalicIcon,
  StrikethroughIcon,
  UnderlineIcon,
  WandSparklesIcon,
} from "lucide-react";
import { KEYS } from "platejs";
import { useEditorReadOnly } from "platejs/react";

import {
  ENABLE_PLATE_ADVANCED_BLOCKS,
  ENABLE_PLATE_AI,
  ENABLE_PLATE_REVIEW,
} from "@/shared/config/plate-feature-flags";
import { AIToolbarButton } from "./ai-toolbar-button";
import { CommentToolbarButton } from "./comment-toolbar-button";
import { InlineEquationToolbarButton } from "./equation-toolbar-button";
import { LinkToolbarButton } from "./link-toolbar-button";
import { MarkToolbarButton } from "./mark-toolbar-button";
import { MoreToolbarButton } from "./more-toolbar-button";
import { SuggestionToolbarButton } from "./suggestion-toolbar-button";
import { ToolbarGroup } from "./toolbar";
import { TurnIntoToolbarButton } from "./turn-into-toolbar-button";

export function FloatingToolbarButtons({ labels = {} }: {
  labels?: Partial<Record<
    "bold" | "italic" | "underline" | "strikethrough" |
    "code" | "link" | "turnInto" | "more", string
  >>;
}) {
  const readOnly = useEditorReadOnly();

  return (
    <>
      {!readOnly && (
        <>
          {ENABLE_PLATE_AI && (
            <ToolbarGroup>
              <AIToolbarButton tooltip="AI commands">
                <WandSparklesIcon />
                Ask AI
              </AIToolbarButton>
            </ToolbarGroup>
          )}

          <ToolbarGroup>
            <TurnIntoToolbarButton tooltip={labels.turnInto} />

            <MarkToolbarButton
              nodeType={KEYS.bold}
              aria-label={labels.bold}
              tooltip={labels.bold ?? "Bold (⌘+B)"}
            >
              <BoldIcon />
            </MarkToolbarButton>

            <MarkToolbarButton
              nodeType={KEYS.italic}
              aria-label={labels.italic}
              tooltip={labels.italic ?? "Italic (⌘+I)"}
            >
              <ItalicIcon />
            </MarkToolbarButton>

            <MarkToolbarButton
              nodeType={KEYS.underline}
              aria-label={labels.underline}
              tooltip={labels.underline ?? "Underline (⌘+U)"}
            >
              <UnderlineIcon />
            </MarkToolbarButton>

            <MarkToolbarButton
              nodeType={KEYS.strikethrough}
              aria-label={labels.strikethrough}
              tooltip={labels.strikethrough ?? "Strikethrough (⌘+⇧+M)"}
            >
              <StrikethroughIcon />
            </MarkToolbarButton>

            <MarkToolbarButton
              nodeType={KEYS.code}
              aria-label={labels.code}
              tooltip={labels.code ?? "Code (⌘+E)"}
            >
              <Code2Icon />
            </MarkToolbarButton>

            {ENABLE_PLATE_ADVANCED_BLOCKS && <InlineEquationToolbarButton />}

            <LinkToolbarButton aria-label={labels.link} tooltip={labels.link} />
          </ToolbarGroup>
        </>
      )}

      <ToolbarGroup>
        {ENABLE_PLATE_REVIEW && (
          <>
            <CommentToolbarButton />
            <SuggestionToolbarButton />
          </>
        )}

        {!readOnly && <MoreToolbarButton tooltip={labels.more} />}
      </ToolbarGroup>
    </>
  );
}
