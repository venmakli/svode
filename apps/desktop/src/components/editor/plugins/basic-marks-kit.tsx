"use client";

import {
  BoldRules,
  ItalicRules,
  UnderlineRules,
  CodeRules,
  StrikethroughRules,
  SubscriptRules,
  SuperscriptRules,
  HighlightRules,
  MarkComboRules,
} from "@platejs/basic-nodes";

import {
  BoldPlugin,
  CodePlugin,
  HighlightPlugin,
  ItalicPlugin,
  KbdPlugin,
  StrikethroughPlugin,
  SubscriptPlugin,
  SuperscriptPlugin,
  UnderlinePlugin,
} from "@platejs/basic-nodes/react";

import { CodeLeaf } from "@/components/ui/code-node";
import { HighlightLeaf } from "@/components/ui/highlight-node";
import { KbdLeaf } from "@/components/ui/kbd-node";

export const BasicMarksKit = [
  BoldPlugin.configure({
    inputRules: [
      BoldRules.markdown(),
      MarkComboRules.markdown({ variant: "boldItalic" }),
      MarkComboRules.markdown({ variant: "boldItalicUnderline" }),
      MarkComboRules.markdown({ variant: "boldUnderline" }),
      MarkComboRules.markdown({ variant: "italicUnderline" }),
    ],
  }),
  ItalicPlugin.configure({
    inputRules: [
      ItalicRules.markdown(),
      ItalicRules.markdown({ variant: "_" }),
    ],
  }),
  UnderlinePlugin.configure({ inputRules: [UnderlineRules.markdown()] }),
  CodePlugin.configure({
    inputRules: [CodeRules.markdown()],
    node: { component: CodeLeaf },
    shortcuts: { toggle: { keys: "mod+e" } },
  }),
  StrikethroughPlugin.configure({
    inputRules: [StrikethroughRules.markdown()],
    shortcuts: { toggle: { keys: "mod+shift+x" } },
  }),
  SubscriptPlugin.configure({
    inputRules: [SubscriptRules.markdown()],
    shortcuts: { toggle: { keys: "mod+comma" } },
  }),
  SuperscriptPlugin.configure({
    inputRules: [SuperscriptRules.markdown()],
    shortcuts: { toggle: { keys: "mod+period" } },
  }),
  HighlightPlugin.configure({
    inputRules: [
      HighlightRules.markdown(),
      HighlightRules.markdown({ variant: "≡" }),
    ],
    node: { component: HighlightLeaf },
    shortcuts: { toggle: { keys: "mod+shift+h" } },
  }),
  KbdPlugin.withComponent(KbdLeaf),
];
