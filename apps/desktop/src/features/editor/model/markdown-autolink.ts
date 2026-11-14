import {
  type DeserializeMdOptions,
  REMARK_MDX_TAG,
  tagRemarkPlugin,
} from "@platejs/markdown";
import { autolink } from "micromark-core-commonmark";

type RemarkPlugin = NonNullable<DeserializeMdOptions["remarkPlugins"]>[number];
type Construct = typeof autolink;
type ConstructHook = Construct | Construct[] | undefined;
type SyntaxExtension = { flow?: Record<number, ConstructHook> };

const LESS_THAN = 60;
const MDX_JSX_FLOW_TAG = "mdxJsxFlowTag";

const mdxAutolink: Construct = { ...autolink, name: "svodeMdxAutolink" };

function mdxJsxFlowTag(extensions: SyntaxExtension[]): Construct | undefined {
  for (const extension of extensions) {
    const hook = extension.flow?.[LESS_THAN];
    const found = (Array.isArray(hook) ? hook : [hook]).find(
      (construct) => construct?.name === MDX_JSX_FLOW_TAG,
    );
    if (found) return found;
  }
  return undefined;
}

/**
 * JSX of the flow, tried at a `<` that starts a line, fails the parse on an
 * autolink instead of leaving the line to a paragraph. The same construct
 * under another name first checks for an autolink and leaves it to the text.
 */
function autolinkGuarded(flowTag: Construct): Construct {
  return {
    ...flowTag,
    name: "svodeMdxJsxFlowTag",
    tokenize(effects, ok, nok) {
      return effects.check(mdxAutolink, nok, (code) =>
        flowTag.tokenize.call(this, effects, ok, nok)(code),
      );
    },
  };
}

/**
 * `remark-mdx` turns the CommonMark autolink construct off by its name, so
 * `<https://…>` and `<me@example.com>` would be read as JSX and fail the MDX
 * parse. The same construct under another name, tried before JSX, reads them
 * as links again; any other `<` is left to JSX. The tokens keep their
 * CommonMark names, so `mdast-util-from-markdown` makes the usual links.
 *
 * Tagged as part of MDX: a parse without MDX reads autolinks by CommonMark.
 * Runs after `remark-mdx`, whose JSX of the flow it guards.
 */
export const remarkMdxAutolinks = tagRemarkPlugin(function (this: {
  data(): Record<string, unknown>;
}) {
  const data = this.data() as { micromarkExtensions?: SyntaxExtension[] };
  const extensions = (data.micromarkExtensions ??= []);
  const flowTag = mdxJsxFlowTag(extensions);
  extensions.push({
    text: { [LESS_THAN]: mdxAutolink },
    ...(flowTag && {
      flow: { [LESS_THAN]: autolinkGuarded(flowTag) },
      disable: { null: [MDX_JSX_FLOW_TAG] },
    }),
  } as SyntaxExtension);
}, REMARK_MDX_TAG) as unknown as RemarkPlugin;
