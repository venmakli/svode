import {
  convertNodesSerialize,
  defaultRules,
  type MdLink,
  type MdLinkReference,
  type MdRules,
  type SerializeMdOptions,
} from "@platejs/markdown";
import type { SlateEditor, TLinkElement } from "platejs";

import type { WrittenContainerCheck } from "./markdown-escapes";
import {
  type MarkdownReference,
  referenceOf,
  writableReference,
} from "./markdown-references";
import type { MarkdownSourceAnnotator, MdastNode } from "./markdown-source";

/**
 * Plate's link element has no title: its `a` rule drops the title of
 * `[text](url "title")` on read. The link element keeps it as `title`, which
 * moves, copies and is undone with the link, and is written back on save.
 * Links made in the editor have none. A link read from a reference link also
 * keeps that reference (see `markdown-references`), and one read from an
 * autolink `<…>` or a bare URL, `www.` or email keeps the source text of that
 * form as `autolink`.
 */
export type TitledLinkElement = TLinkElement & {
  title?: string;
  reference?: MarkdownReference;
  autolink?: string;
};

const link = defaultRules.a!;

const AUTOLINK_DATA = "svodeAutolink";

/**
 * Records on a link read from an autolink `<…>` or a GFM literal (a bare
 * `http(s)://`, `www.` or email) the source text of that form. A link written
 * with brackets, inline or by reference, records nothing.
 */
export const annotateAutolinkSource: MarkdownSourceAnnotator = (
  node,
  _ancestors,
  view,
) => {
  if (node.type !== "link") return;
  const range = view.range(node);
  if (!range) return;
  const source = view.source.slice(range.start, range.end);
  if (!source || source.startsWith("[")) return;
  node.data = { ...node.data, [AUTOLINK_DATA]: source };
};

/**
 * A link whose text is its address, written in the first of its `forms` that
 * reads as the same link where it stands: bare, `<…>`, and `[text](url)` when
 * none is left. A check of the written container (`checkAutolinkForms`) drops
 * the forms that read otherwise.
 */
const AUTOLINK_TYPE = "svodeAutolink";

type AutolinkForm = "bare" | "angle";

interface AutolinkNode extends MdastNode {
  url: string;
  data: { forms: AutolinkForm[]; text: string };
}

const BARE_HINT_RE = /^(?:https?:\/\/|www\.|mailto:|xmpp:)|@/i;
const SCHEME_RE = /^[a-z][a-z0-9+.-]{1,31}:/i;
const NOT_IN_AUTOLINK_RE = /[\0- <>\u007F]/;

/**
 * The forms to try for a link with the single plain text `text`: the one it
 * was read from while its text still is that form, then the forms after it;
 * bare and then `<…>` for a link whose text is its address. Forms that cannot
 * read as a link at all are left out.
 */
function autolinkForms(
  element: TitledLinkElement,
  text: string,
): AutolinkForm[] {
  let forms: AutolinkForm[];
  if (element.autolink === `<${text}>`) forms = ["angle"];
  else if (element.autolink === text || element.url === text) {
    forms = ["bare", "angle"];
  } else return [];
  return forms.filter((form) =>
    form === "bare"
      ? BARE_HINT_RE.test(text) && !/\s/.test(text)
      : !NOT_IN_AUTOLINK_RE.test(text) &&
        (SCHEME_RE.test(text) || text.includes("@")),
  );
}

function formText(node: AutolinkNode): string | null {
  const [form] = node.data.forms;
  if (form === "bare") return node.data.text;
  if (form === "angle") return `<${node.data.text}>`;
  return null;
}

type Handlers = NonNullable<
  NonNullable<SerializeMdOptions["remarkStringifyOptions"]>["handlers"]
>;
type Handle = NonNullable<Handlers["link"]>;

const writeAutolinkNode: Handle = (mdastNode, parent, state, info) => {
  const node = mdastNode as unknown as AutolinkNode;
  const form = formText(node);
  // Inside an autolink and a literal `\` is part of the address: the text is
  // written as it is.
  if (form !== null) return form;
  const { resourceLink } = state.options;
  state.options.resourceLink = true;
  try {
    return state.handle(
      { ...mdastNode, type: "link", title: null },
      parent,
      state,
      info,
    );
  } finally {
    state.options.resourceLink = resourceLink;
  }
};

const peekAutolink: Handle = (mdastNode) =>
  formText(mdastNode as unknown as AutolinkNode)?.charAt(0) ?? "[";

const writeAutolink = Object.assign(writeAutolinkNode, { peek: peekAutolink });

/** `remark-stringify` handlers of the links `markdownLinkRules` writes. */
export const markdownLinkHandlers = {
  [AUTOLINK_TYPE]: writeAutolink,
} as unknown as Handlers;

export const markdownLinkRules: MdRules = {
  a: {
    deserialize: (mdastNode, deco, options) => {
      const element = link.deserialize!(mdastNode, deco, options);
      const reference = referenceOf(mdastNode);
      const autolink = (
        mdastNode.data as Record<string, unknown> | undefined
      )?.[AUTOLINK_DATA];
      return {
        ...element,
        ...(typeof mdastNode.title === "string" && { title: mdastNode.title }),
        ...(reference && { reference }),
        ...(typeof autolink === "string" && { autolink }),
      };
    },
    serialize: (node, options) => {
      const element = node as TitledLinkElement;
      const reference = writableReference(element, options);
      if (reference) {
        const linkReference: MdLinkReference = {
          ...reference,
          children: convertNodesSerialize(
            node.children,
            options,
          ) as MdLinkReference["children"],
          type: "linkReference",
        };
        // Plate types the result of rule `a` as a link.
        return linkReference as unknown as MdLink;
      }
      const children = convertNodesSerialize(
        node.children,
        options,
      ) as MdLink["children"];
      const { title } = element;
      if (typeof title === "string") {
        // Plate writes a link whose text is its URL as a bare autolink, which
        // has no title.
        return { children, title, type: "link", url: node.url };
      }
      const [only] = children;
      const forms =
        children.length === 1 &&
        only?.type === "text" &&
        options.remarkStringifyOptions?.resourceLink !== true
          ? autolinkForms(element, only.value)
          : [];
      if (forms.length === 0) return link.serialize!(node, options);
      const autolink: AutolinkNode = {
        type: AUTOLINK_TYPE,
        url: node.url,
        children: children as MdastNode[],
        data: { forms, text: (only as { value: string }).value },
      };
      // Plate types the result of rule `a` as a link.
      return autolink as unknown as MdLink;
    },
  },
};

interface LinkSpan {
  start: number;
  end: number;
  url: string;
  text: string;
}

const CACHE_LIMIT = 4000;
const spanCache = new WeakMap<SlateEditor, Map<string, LinkSpan[]>>();

function textOf(node: MdastNode): string {
  return typeof node.value === "string"
    ? node.value
    : (node.children ?? []).map(textOf).join("");
}

function linkSpans(
  editor: SlateEditor,
  written: Parameters<WrittenContainerCheck>[2],
): LinkSpan[] {
  let cache = spanCache.get(editor);
  if (!cache) {
    cache = new Map();
    spanCache.set(editor, cache);
  }
  let spans = cache.get(written.key);
  if (!spans) {
    const { tree, toWritten } = written.read();
    const found: LinkSpan[] = [];
    const visit = (node: MdastNode) => {
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (node.type === "link" && start !== undefined && end !== undefined) {
        found.push({
          start: toWritten(start),
          end: toWritten(end),
          url: String((node as MdastNode & { url?: string }).url),
          text: textOf(node),
        });
      }
      for (const child of node.children ?? []) visit(child);
    };
    visit(tree);
    spans = found;
    if (cache.size >= CACHE_LIMIT) cache.clear();
    cache.set(written.key, spans);
  }
  return spans;
}

function autolinksOf(node: MdastNode, found: AutolinkNode[] = []) {
  if (node.type === AUTOLINK_TYPE) {
    if ((node as AutolinkNode).data.forms.length > 0) {
      found.push(node as AutolinkNode);
    }
    return found;
  }
  for (const child of node.children ?? []) autolinksOf(child, found);
  return found;
}

/**
 * Reads the written container and moves every autolink that does not read as
 * the same link, with the same text and no more, to its next form. It looks
 * at the text around the link as it is written, whatever its escapes.
 */
export const checkAutolinkForms: WrittenContainerCheck = (
  editor,
  container,
  written,
) => {
  const autolinks = autolinksOf(container);
  if (autolinks.length === 0) return false;
  const spans = linkSpans(editor, written);
  let cursor = 0;
  let changed = false;
  for (const node of autolinks) {
    const form = formText(node)!;
    const start = written.text.indexOf(form, cursor);
    const reads =
      start !== -1 &&
      spans.some(
        (span) =>
          span.start === start &&
          span.end === start + form.length &&
          span.url === node.url &&
          span.text === node.data.text,
      );
    if (start !== -1) cursor = start + form.length;
    if (!reads) {
      node.data.forms.shift();
      changed = true;
    }
  }
  return changed;
};
