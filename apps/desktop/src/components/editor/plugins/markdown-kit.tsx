import { MarkdownPlugin, remarkMdx, remarkMention } from "@platejs/markdown";
import { KEYS } from "platejs";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";

export const stableMarkdownStringifyOptions = {
  bullet: "-",
  bulletOther: "*",
  bulletOrdered: ".",
  emphasis: "*",
  fence: "`",
  fences: true,
  incrementListMarker: true,
  listItemIndent: "one",
  rule: "-",
  ruleRepetition: 3,
  ruleSpaces: false,
  strong: "*",
} as const;

export const MarkdownKit = [
  MarkdownPlugin.configure({
    options: {
      plainMarks: [KEYS.suggestion, KEYS.comment],
      remarkPlugins: [remarkMath, remarkGfm, remarkMdx, remarkMention],
      remarkStringifyOptions: stableMarkdownStringifyOptions,
    },
  }),
];
