import {
  markdownToAstProcessor,
  serializeMd,
  type DeserializeMdOptions,
  type MdRules,
  type SerializeMdOptions,
} from "@platejs/markdown";
import {
  type Descendant,
  ElementApi,
  getPluginType,
  KEYS,
  type SlateEditor,
  type TElement,
} from "platejs";

import {
  applyTextEdits,
  HTML_COMMENT_RE,
  mapHtmlToJsx,
  type MappedText,
  type MarkdownSourceAnnotator,
  type MdastNode,
} from "./markdown-source";

/**
 * Markdown comments (`<!-- … -->`, `{/* … *\/}`, `[//]: # …`) and link
 * definitions (`[label]: destination "title"`) are kept in the editor value as
 * void elements holding their exact source text, and written back unchanged.
 */

export const MARKDOWN_COMMENT_KEY = "markdown_comment";
export const MARKDOWN_INLINE_COMMENT_KEY = "markdown_comment_inline";
export const MARKDOWN_LINK_DEFINITION_KEY = "markdown_link_definition";
/** A link definition that opens a list item, inside the item paragraph. */
export const MARKDOWN_INLINE_LINK_DEFINITION_KEY =
  "markdown_link_definition_inline";

export interface MarkdownCommentElement extends TElement {
  type: typeof MARKDOWN_COMMENT_KEY | typeof MARKDOWN_INLINE_COMMENT_KEY;
  /** Source text of the comment, as written in the file. */
  raw: string;
  children: [{ text: "" }];
  indent?: number;
}

export interface MarkdownLinkDefinitionElement extends TElement {
  type:
    | typeof MARKDOWN_LINK_DEFINITION_KEY
    | typeof MARKDOWN_INLINE_LINK_DEFINITION_KEY;
  /**
   * Source text of the definition, as written in the file, without the
   * prefixes of the containers around it.
   */
  raw: string;
  children: [{ text: "" }];
  indent?: number;
}

type MarkerElement = MarkdownCommentElement | MarkdownLinkDefinitionElement;

interface CommentSource {
  raw: string;
  /** A link definition rather than a comment. */
  linkDefinition: boolean;
  /** The comment opens a list item, where Plate keeps only a paragraph. */
  leadsListItem: boolean;
}

const COMMENT_DATA = "svodeMarkdownComment";
const BLOCK_COMMENT_DATA = "svodeBlockComment";
const LINK_DEFINITION_DATA = "svodeLinkDefinition";

const BLOCK_MARKER_KEYS = new Set<string>([
  MARKDOWN_COMMENT_KEY,
  MARKDOWN_LINK_DEFINITION_KEY,
]);

function isCommentOnlyExpression(node: MdastNode): boolean {
  const program = node.data?.estree as
    | { body?: unknown[]; comments?: unknown[] }
    | undefined;
  return program?.body?.length === 0 && (program.comments?.length ?? 0) > 0;
}

function isComment(node: MdastNode): boolean {
  if (node.type === "definition") return node.label === "//";
  return (
    (node.type === "mdxFlowExpression" || node.type === "mdxTextExpression") &&
    isCommentOnlyExpression(node)
  );
}

/**
 * Attaches the source text to every comment and link definition in Plate's
 * parse.
 */
export const annotateMarkdownComment: MarkdownSourceAnnotator = (
  node,
  ancestors,
  view,
) => {
  const linkDefinition = node.type === "definition" && !isComment(node);
  if (!linkDefinition && !isComment(node)) return;
  const raw = view.innerText(node, ancestors);
  if (raw === null) return;
  const parent = ancestors.at(-1);
  const comment: CommentSource = {
    raw,
    linkDefinition,
    leadsListItem: parent?.type === "listItem" && parent.children?.[0] === node,
  };
  node.data = { ...node.data, [COMMENT_DATA]: comment };
};

function markerElement(
  type: MarkerElement["type"],
  raw: string,
): MarkerElement {
  return { type, raw, children: [{ text: "" }] } as MarkerElement;
}

function deserializeComment(block: boolean) {
  return (
    node: { data?: object },
    _deco: unknown,
    options: DeserializeMdOptions,
  ) => {
    const comment = (node.data as Record<string, unknown> | undefined)?.[
      COMMENT_DATA
    ] as CommentSource | undefined;
    if (!comment) return [];
    const [blockType, inlineType] = comment.linkDefinition
      ? ([
          MARKDOWN_LINK_DEFINITION_KEY,
          MARKDOWN_INLINE_LINK_DEFINITION_KEY,
        ] as const)
      : ([MARKDOWN_COMMENT_KEY, MARKDOWN_INLINE_COMMENT_KEY] as const);
    if (!block) return markerElement(inlineType, comment.raw);
    if (!comment.leadsListItem) return markerElement(blockType, comment.raw);
    // Plate turns the first block of a list item into the item paragraph.
    return {
      type: options.editor ? getPluginType(options.editor, KEYS.p) : KEYS.p,
      children: [markerElement(inlineType, comment.raw)],
    };
  };
}

const serializeBlockMarker = (node: MarkerElement) => ({
  type: "html",
  value: node.raw,
  data: {
    [BLOCK_COMMENT_DATA]: true,
    ...(node.type === MARKDOWN_LINK_DEFINITION_KEY && {
      [LINK_DEFINITION_DATA]: true,
    }),
  },
});

const serializeInlineMarker = (node: MarkerElement) => ({
  type: "html",
  value: node.raw,
  ...(node.type === MARKDOWN_INLINE_LINK_DEFINITION_KEY && {
    data: { [LINK_DEFINITION_DATA]: true },
  }),
});

export const markdownCommentRules: MdRules = {
  definition: { deserialize: deserializeComment(true) },
  mdxFlowExpression: { deserialize: deserializeComment(true) },
  mdxTextExpression: { deserialize: deserializeComment(false) },
  [MARKDOWN_COMMENT_KEY]: { serialize: serializeBlockMarker },
  [MARKDOWN_INLINE_COMMENT_KEY]: { serialize: serializeInlineMarker },
  [MARKDOWN_LINK_DEFINITION_KEY]: { serialize: serializeBlockMarker },
  [MARKDOWN_INLINE_LINK_DEFINITION_KEY]: { serialize: serializeInlineMarker },
};

// Node types `mdast-util-phrasing` treats as phrasing, as the default
// mdast-util-to-markdown root handler does.
const PHRASING_TYPES = new Set([
  "break",
  "delete",
  "emphasis",
  "footnote",
  "footnoteReference",
  "image",
  "imageReference",
  "inlineCode",
  "inlineMath",
  "link",
  "linkReference",
  "mdxJsxTextElement",
  "mdxTextExpression",
  "strong",
  "text",
]);

interface MdastList extends MdastNode {
  ordered?: boolean | null;
  start?: number | null;
}

function isBlockComment(node: MdastNode | undefined): boolean {
  return node?.type === "html" && node.data?.[BLOCK_COMMENT_DATA] === true;
}

function isCarrierItem(item: MdastNode): boolean {
  const content = item.children;
  return (
    content?.[0]?.type === "paragraph" &&
    content[0].children?.length === 1 &&
    isBlockComment(content[0].children[0])
  );
}

// Splits every list at its carrier items: the comment takes the carrier's
// place inside the parent item, and the list continues after it.
function unwrapListComments(node: MdastNode) {
  const children = node.children;
  if (!children) return;
  for (const child of children) unwrapListComments(child);
  if (!children.some((child) => child.type === "list")) return;

  node.children = children.flatMap((child) => {
    if (child.type !== "list" || !child.children?.some(isCarrierItem)) {
      return [child];
    }
    const list = child as MdastList;
    const parts: MdastNode[] = [];
    let items: MdastNode[] = [];
    let start = typeof list.start === "number" ? list.start : 1;
    const flushItems = () => {
      if (items.length === 0) return;
      parts.push({
        ...list,
        start: list.ordered ? start : list.start,
        children: items,
      } as MdastNode);
      start += items.length;
      items = [];
    };
    for (const item of list.children ?? []) {
      if (!isCarrierItem(item)) {
        items.push(item);
        continue;
      }
      flushItems();
      parts.push(item.children![0].children![0], ...item.children!.slice(1));
    }
    flushItems();
    return parts;
  });
}

function rootHandler(
  node: MdastNode,
  _parent: unknown,
  state: {
    containerFlow(node: MdastNode, info: unknown): string;
    containerPhrasing(node: MdastNode, info: unknown): string;
  },
  info: unknown,
): string {
  unwrapListComments(node);
  return node.children?.some((child) => PHRASING_TYPES.has(child.type))
    ? state.containerPhrasing(node, info)
    : state.containerFlow(node, info);
}

// A `[//]: #` definition cannot interrupt the paragraph before it.
function joinCommentDefinition(left: MdastNode, right: MdastNode) {
  return left.type === "paragraph" &&
    isBlockComment(right) &&
    right.value?.startsWith("[")
    ? 1
    : undefined;
}

// A link definition that opens a list item is the only content of the item
// paragraph.
function isLinkDefinition(node: MdastNode): boolean {
  if (node.type === "html") return node.data?.[LINK_DEFINITION_DATA] === true;
  return (
    node.type === "paragraph" &&
    node.children?.length === 1 &&
    isLinkDefinition(node.children[0])
  );
}

// Consecutive link definitions are written as one group.
function joinLinkDefinitions(left: MdastNode, right: MdastNode) {
  return isLinkDefinition(left) && isLinkDefinition(right) ? 0 : undefined;
}

type RemarkPlugin = NonNullable<DeserializeMdOptions["remarkPlugins"]>[number];

/**
 * Puts a block comment that belongs to a list item back inside that item:
 * the comment travels through Plate's list serializer as a carrier list item
 * (see `withListCommentCarriers`), which is unwrapped here.
 */
export const remarkMarkdownComments = function (this: {
  data(): Record<string, unknown>;
}) {
  const data = this.data() as { toMarkdownExtensions?: unknown[] };
  (data.toMarkdownExtensions ??= []).push({
    handlers: { root: rootHandler },
    // Joins run last to first.
    join: [joinCommentDefinition, joinLinkDefinitions],
  });
} as unknown as RemarkPlugin;

type ListParagraph = TElement & { indent: number; listStyleType: string };

/**
 * Plate's list serializer ends a list at any block that is not a list
 * paragraph. A block comment indented under a list item is therefore passed
 * to it as a list paragraph that only carries the comment.
 */
function withListCommentCarriers(
  editor: SlateEditor,
  nodes: Descendant[],
): Descendant[] {
  const paragraphType = getPluginType(editor, KEYS.p);
  let run: Map<number, string> | null = null;
  let changed = false;

  const result = nodes.map((node) => {
    if (!ElementApi.isElement(node)) return node;
    const indent = typeof node.indent === "number" ? node.indent : 0;
    if (node.type === paragraphType && "listStyleType" in node) {
      run ??= new Map();
      for (const key of run.keys()) if (key > indent) run.delete(key);
      run.set(indent, String((node as ListParagraph).listStyleType));
    } else if (BLOCK_MARKER_KEYS.has(node.type) && indent > 1 && run) {
      changed = true;
      return {
        type: paragraphType,
        indent,
        listStyleType: run.get(indent) ?? "disc",
        children: [node],
      } as Descendant;
    } else {
      run = null;
    }
    const children = withListCommentCarriers(editor, node.children);
    if (children === node.children) return node;
    changed = true;
    return { ...node, children } as Descendant;
  });

  return changed ? result : nodes;
}

export function serializeMarkdownWithComments(
  editor: SlateEditor,
  options?: Omit<SerializeMdOptions, "editor">,
): string {
  return serializeMd(editor, {
    ...options,
    value: withListCommentCarriers(editor, options?.value ?? editor.children),
  });
}

function placeOf(error: unknown): number | null {
  const place = (
    error as { place?: { offset?: number; start?: { offset?: number } } }
  )?.place;
  return place?.offset ?? place?.start?.offset ?? null;
}

/**
 * An unclosed `<!--` is not a comment, but it makes the MDX parse fail and
 * sends the whole document to Plate's lossy fallback. Each unclosed opener the
 * MDX parse stops at is escaped so the rest of the document parses normally.
 */
export function escapeUnclosedCommentOpeners(
  editor: SlateEditor,
  markdown: string,
): MappedText {
  if (!markdown.replace(new RegExp(HTML_COMMENT_RE), "").includes("<!--")) {
    return applyTextEdits(markdown, []);
  }
  const escapes: number[] = [];
  for (;;) {
    const current = applyTextEdits(
      markdown,
      escapes.map((offset) => ({ start: offset, end: offset, text: "\\" })),
    );
    const parsed = mapHtmlToJsx(current.text);
    if (!parsed) return current;
    try {
      markdownToAstProcessor(editor, parsed.text);
      return current;
    } catch (error) {
      const place = placeOf(error);
      if (place === null) return current;
      const opener = parsed.toInput(place) - 1;
      const offset = current.toInput(opener);
      if (
        !current.text.startsWith("<!--", opener) ||
        escapes.includes(offset)
      ) {
        return current;
      }
      escapes.push(offset);
    }
  }
}
