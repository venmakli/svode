import {
  type DeserializeMdOptions,
  REMARK_MDX_TAG,
  tagRemarkPlugin,
} from "@platejs/markdown";
import { autolink } from "micromark-core-commonmark";

type RemarkPlugin = NonNullable<DeserializeMdOptions["remarkPlugins"]>[number];

const LESS_THAN = 60;

/**
 * `remark-mdx` turns the CommonMark autolink construct off by its name, so
 * `<https://…>` and `<me@example.com>` would be read as JSX and fail the MDX
 * parse. The same construct under another name, tried before JSX, reads them
 * as links again; any other `<` is left to JSX. The tokens keep their
 * CommonMark names, so `mdast-util-from-markdown` makes the usual links.
 *
 * Tagged as part of MDX: a parse without MDX reads autolinks by CommonMark.
 */
export const remarkMdxAutolinks = tagRemarkPlugin(function (this: {
  data(): Record<string, unknown>;
}) {
  const data = this.data() as { micromarkExtensions?: unknown[] };
  (data.micromarkExtensions ??= []).push({
    text: { [LESS_THAN]: { ...autolink, name: "svodeMdxAutolink" } },
  });
}, REMARK_MDX_TAG) as unknown as RemarkPlugin;
