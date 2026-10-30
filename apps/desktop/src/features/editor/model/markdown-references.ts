import {
  defaultRules,
  htmlToJsx,
  markdownToAstProcessor,
  type DeserializeMdOptions,
  type MdImage,
  type MdImageReference,
  type MdLinkReference,
  type MdParagraph,
  type MdRules,
  type SerializeMdOptions,
} from "@platejs/markdown";
import {
  type Descendant,
  ElementApi,
  type SlateEditor,
  type TElement,
} from "platejs";

import {
  MARKDOWN_COMMENT_KEY,
  MARKDOWN_INLINE_COMMENT_KEY,
  MARKDOWN_INLINE_LINK_DEFINITION_KEY,
  MARKDOWN_LINK_DEFINITION_KEY,
} from "./markdown-comments";
import type { MdastNode } from "./markdown-source";

/**
 * Reference links and images (`[text][label]`, `[label][]`, `[label]`,
 * `![alt][label]`) are resolved by the definitions of the document before
 * Plate sees them: Plate has no rules for them. They become ordinary links and
 * images whose element remembers the reference. A save writes such an element
 * in its reference form again while the document still has a definition of
 * the label with the element's target; otherwise it is written inline.
 */

export interface MarkdownReference {
  identifier: string;
  label: string;
  referenceType: MdLinkReference["referenceType"];
}

/** A link, image or inline image element that came from a reference. */
export interface ReferenceElement extends TElement {
  url: string;
  title?: string;
  reference?: MarkdownReference;
}

export interface LinkDefinition {
  url: string;
  title: string | null;
}

/** Link definitions by identifier, the first of each label in document order. */
export type LinkDefinitions = Map<string, LinkDefinition>;

const REFERENCE_DATA = "svodeReference";

interface MdastDefinition extends MdastNode {
  identifier: string;
  url: string;
  title?: string | null;
}

/** A link or image node of the parse. */
interface MdastTarget extends MdastNode {
  url: string;
  title: string | null;
  alt?: string | null;
}

interface MdastReference extends MdastNode {
  identifier: string;
  label?: string | null;
  referenceType: MarkdownReference["referenceType"];
  alt?: string | null;
}

function visit(node: MdastNode, callback: (node: MdastNode) => void) {
  callback(node);
  for (const child of node.children ?? []) visit(child, callback);
}

function addDefinition(
  definitions: LinkDefinitions,
  { identifier, url, title }: MdastDefinition,
) {
  if (!definitions.has(identifier)) {
    definitions.set(identifier, { url, title: title ?? null });
  }
}

function treeDefinitions(tree: MdastNode): LinkDefinitions {
  const definitions: LinkDefinitions = new Map();
  visit(tree, (node) => {
    if (node.type === "definition") {
      addDefinition(definitions, node as MdastDefinition);
    }
  });
  return definitions;
}

const MARKER_KEYS = new Set<string>([
  MARKDOWN_LINK_DEFINITION_KEY,
  MARKDOWN_INLINE_LINK_DEFINITION_KEY,
  MARKDOWN_COMMENT_KEY,
  MARKDOWN_INLINE_COMMENT_KEY,
]);

const markerDefinitions = new WeakMap<TElement, MdastDefinition | null>();

// The definition a marker keeps the source text of, parsed as Plate parses
// the document.
function markerDefinition(
  editor: SlateEditor,
  marker: TElement & { raw?: unknown },
): MdastDefinition | null {
  const cached = markerDefinitions.get(marker);
  if (cached !== undefined) return cached;
  let definition: MdastDefinition | null = null;
  if (typeof marker.raw === "string" && marker.raw.startsWith("[")) {
    try {
      const tree = markdownToAstProcessor(
        editor,
        htmlToJsx(marker.raw),
      ) as MdastNode;
      visit(tree, (node) => {
        if (!definition && node.type === "definition") {
          definition = node as MdastDefinition;
        }
      });
    } catch {
      definition = null;
    }
  }
  markerDefinitions.set(marker, definition);
  return definition;
}

const valueDefinitions = new WeakMap<Descendant[], LinkDefinitions>();

/** The link definitions an editor value keeps as markers. */
export function linkDefinitionsOf(
  editor: SlateEditor,
  value: Descendant[],
): LinkDefinitions {
  const cached = valueDefinitions.get(value);
  if (cached) return cached;
  const definitions: LinkDefinitions = new Map();
  const walk = (nodes: Descendant[]) => {
    for (const node of nodes) {
      if (!ElementApi.isElement(node)) continue;
      if (MARKER_KEYS.has(node.type)) {
        const definition = markerDefinition(editor, node);
        if (definition) addDefinition(definitions, definition);
      }
      walk(node.children);
    }
  };
  walk(value);
  valueDefinitions.set(value, definitions);
  return definitions;
}

type RemarkPlugin = NonNullable<DeserializeMdOptions["remarkPlugins"]>[number];

export interface ReferenceResolution {
  /** Remark transformer that resolves the references of the parse. */
  plugin: RemarkPlugin;
  /**
   * Text to append to the Markdown being parsed. A reference is only a
   * reference when its label is defined in the parsed text, so labels defined
   * elsewhere in the document are defined again after it; the plugin removes
   * these definitions from the parse.
   */
  suffix: string;
  /** Whether the parse ended with exactly the appended definitions. */
  isComplete(): boolean;
}

/**
 * Resolves references by `definitions`, the definitions of the document, and
 * by those of the parsed text for labels it does not define.
 */
export function createReferenceResolution(
  definitions?: LinkDefinitions,
): ReferenceResolution {
  const labels = [...(definitions?.keys() ?? [])];
  const suffix =
    labels.length > 0
      ? `\n\n${labels.map((label) => `[${label}]: #`).join("\n")}\n`
      : "";
  let complete = suffix === "";

  const removeSuffix = (tree: MdastNode, text: string) => {
    if (!suffix || !text.endsWith(suffix)) return;
    const start = text.length - suffix.length;
    const children = tree.children ?? [];
    const first = children.findIndex(
      (node) => (node.position?.end.offset ?? 0) > start,
    );
    if (first === -1) return;
    const appended = children.slice(first);
    if (
      appended.length !== labels.length ||
      appended.some(
        (node) =>
          node.type !== "definition" ||
          (node.position?.start.offset ?? 0) < start,
      )
    ) {
      return;
    }
    tree.children = children.slice(0, first);
    complete = true;
  };

  const plugin = () => (tree: MdastNode, file: { value?: unknown }) => {
    removeSuffix(tree, String(file.value));
    const own = treeDefinitions(tree);
    const resolve = (node: MdastReference) =>
      definitions?.get(node.identifier) ?? own.get(node.identifier);

    visit(tree, (node) => {
      for (const [index, child] of (node.children ?? []).entries()) {
        if (child.type !== "linkReference" && child.type !== "imageReference") {
          continue;
        }
        const reference = child as MdastReference;
        const definition = resolve(reference);
        if (!definition) continue;
        const data = {
          ...reference.data,
          [REFERENCE_DATA]: {
            identifier: reference.identifier,
            label: reference.label ?? reference.identifier,
            referenceType: reference.referenceType,
          } satisfies MarkdownReference,
        };
        const target: MdastTarget = {
          type: child.type === "linkReference" ? "link" : "image",
          url: definition.url,
          title: definition.title,
          ...(child.type === "imageReference"
            ? { alt: reference.alt ?? null }
            : { children: reference.children }),
          data,
          position: reference.position,
        };
        node.children![index] = target;
      }
    });
  };

  return {
    plugin: plugin as unknown as RemarkPlugin,
    suffix,
    isComplete: () => complete,
  };
}

/** The reference a link or image of the parse came from. */
export function referenceOf(mdastNode: {
  data?: unknown;
}): MarkdownReference | undefined {
  return (mdastNode.data as Record<string, MarkdownReference> | undefined)?.[
    REFERENCE_DATA
  ];
}

const titleOf = (title: string | null | undefined) => title || undefined;

/**
 * The reference to write an element as: the one it came from, while the
 * serialized value defines its label with the element's target.
 */
export function writableReference(
  element: ReferenceElement,
  options: Pick<SerializeMdOptions, "editor" | "value">,
): MarkdownReference | null {
  const { reference } = element;
  if (!reference || !options.editor || !options.value) return null;
  const definition = linkDefinitionsOf(options.editor, options.value).get(
    reference.identifier,
  );
  return definition &&
    definition.url === element.url &&
    titleOf(definition.title) === titleOf(element.title)
    ? reference
    : null;
}

export function imageReferenceNode(
  reference: MarkdownReference,
  alt: string | undefined,
): MdImageReference {
  return { type: "imageReference", alt, ...reference };
}

const image = defaultRules.img!;

export const markdownImageReferenceRules: MdRules = {
  img: {
    deserialize: (mdastNode: MdImage, deco, options) => {
      const element = image.deserialize!(mdastNode, deco, options);
      const reference = referenceOf(mdastNode);
      return reference ? { ...element, reference } : element;
    },
    serialize: (node, options) => {
      const reference = writableReference(
        node as unknown as ReferenceElement,
        options,
      );
      if (!reference) return image.serialize!(node, options);
      // Plate writes a block image as a paragraph that holds it.
      const paragraph = image.serialize!(
        node,
        options,
      ) as unknown as MdParagraph;
      const [{ alt }] = paragraph.children as MdImage[];
      return {
        ...paragraph,
        children: [imageReferenceNode(reference, alt ?? undefined)],
      } as unknown as MdImage;
    },
  },
};
