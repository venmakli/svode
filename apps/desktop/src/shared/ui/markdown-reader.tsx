import {
  Component,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type ComponentProps,
  type ReactNode,
} from "react";
import { code } from "@streamdown/code";
import { math } from "@streamdown/math";
import { mermaid } from "@streamdown/mermaid";
import {
  defaultRehypePlugins,
  Streamdown,
  type ControlsConfig,
  type MermaidErrorComponentProps,
  type MermaidOptions,
  type StreamdownProps,
  type UrlTransform,
} from "streamdown";

import * as m from "@/paraglide/messages.js";
import { cn } from "@/shared/lib/utils";

type RehypePlugin = NonNullable<StreamdownProps["rehypePlugins"]>[number];

const readerPlugins = { code, math, mermaid } as const;
const readerControls: ControlsConfig = {
  code: false,
  mermaid: { copy: true, download: false, fullscreen: false, panZoom: false },
  table: false,
};
const readerMermaid = {
  dark: { config: { theme: "dark" }, errorComponent: MermaidSourceFallback },
  light: {
    config: { theme: "default" },
    errorComponent: MermaidSourceFallback,
  },
} satisfies Record<DocumentColorScheme, MermaidOptions>;
const readerRehypePlugins: RehypePlugin[] = [urlKeepingSanitize()];
const imageReaderRehypePlugins: RehypePlugin[] = [
  ...readerRehypePlugins,
  imageRuns as RehypePlugin,
];

/**
 * Links and images reach the DOM only through the policy, which receives
 * their URLs as written: a relative path with a line suffix or a `file://`
 * URI is not a URL a sanitizer keeps. HTML stays sanitized as before.
 */
function urlKeepingSanitize(): RehypePlugin {
  const [sanitize, schema] = defaultRehypePlugins.sanitize as [
    unknown,
    { protocols?: Record<string, string[]> },
  ];
  const { href: _href, src: _src, ...protocols } = schema.protocols ?? {};
  return [sanitize, { ...schema, protocols }] as RehypePlugin;
}

/** An image as written: its source goes to the policy untouched. */
export interface MarkdownReaderImage {
  source: string;
  alt: string;
}

export interface MarkdownReaderPolicy {
  /** A link as the policy shows it; nothing leaves its text. */
  renderLink?(href: string, children: ReactNode): ReactNode;
  /** Inline code as the policy shows it; nothing leaves the code as is. */
  renderInlineCode?(code: string, element: ReactNode): ReactNode;
  /**
   * Images in a row of text — consecutive, with only spaces or line breaks
   * between them — as the policy shows them, as a block at their place.
   * Without it, and for an image inside a link or a heading, an image is
   * its alt text.
   */
  renderImages?(images: MarkdownReaderImage[]): ReactNode;
}

/**
 * A link of the policy: it acts through `onOpen`, never by navigation.
 * Other props reach the button, as a tooltip trigger passes them.
 */
export function MarkdownReaderLink({
  children,
  target,
  onOpen,
  className,
  ...props
}: Omit<ComponentProps<"button">, "onClick"> & {
  /** What the link opens, for tests and diagnostics. */
  target: string;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      role="link"
      {...props}
      className={cn(
        "inline cursor-pointer border-0 bg-transparent p-0 text-primary underline underline-offset-4",
        className,
      )}
      data-markdown-reader-link={target}
      onClick={onOpen}
    >
      {children}
    </button>
  );
}

const INLINE_CODE_CLASS = "rounded bg-muted px-1.5 py-0.5 font-mono text-sm";

export interface MarkdownReaderProps {
  className?: string;
  content: string;
  policy: MarkdownReaderPolicy;
}

export function MarkdownReader({
  className,
  content,
  policy,
}: MarkdownReaderProps) {
  const readerRef = useRef<HTMLDivElement>(null);
  const colorScheme = useDocumentColorScheme();
  const components = useMemo<StreamdownProps["components"]>(
    () => ({
      a: ({ children, href }) => {
        const shown = href ? policy.renderLink?.(href, children) : null;
        return (
          shown ?? <span data-markdown-reader-blocked-link>{children}</span>
        );
      },
      img: ({ alt }) =>
        alt ? <span data-markdown-reader-blocked-image>{alt}</span> : null,
      ...(policy.renderImages && {
        div: ({ node, children, ...props }) => {
          const images = imageRunOf(node as HastNode | undefined);
          return images ? (
            policy.renderImages?.(images)
          ) : (
            <div {...props}>{children}</div>
          );
        },
      }),
      ...(policy.renderInlineCode && {
        inlineCode: ({ children }) => {
          const element = (
            <code className={INLINE_CODE_CLASS} data-streamdown="inline-code">
              {children}
            </code>
          );
          const shown =
            typeof children === "string"
              ? policy.renderInlineCode?.(children, element)
              : null;
          return shown ?? element;
        },
      }),
    }),
    [policy],
  );

  useEffect(() => {
    const reader = readerRef.current;
    if (!reader) return;

    const markWideRegions = () => {
      const regions = new Set<HTMLElement>(
        reader.querySelectorAll<HTMLElement>(
          '[data-streamdown="code-block-body"]',
        ),
      );
      for (const table of reader.querySelectorAll<HTMLElement>(
        '[data-streamdown="table"]',
      )) {
        if (table.parentElement) regions.add(table.parentElement);
      }
      for (const region of regions) {
        region.dataset.markdownReaderWideBlock = "";
        region.tabIndex = 0;
      }
    };

    markWideRegions();
    const observer = new MutationObserver(markWideRegions);
    observer.observe(reader, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [content]);

  return (
    <MarkdownReaderBoundary content={content}>
      <div
        ref={readerRef}
        className={cn("w-full min-w-0 max-w-full text-sm", className)}
        data-markdown-reader
      >
        <Streamdown
          className="w-full min-w-0 max-w-full"
          mode="static"
          animated={false}
          components={components}
          controls={readerControls}
          isAnimating={false}
          lineNumbers={false}
          linkSafety={{ enabled: false }}
          mermaid={readerMermaid[colorScheme]}
          plugins={readerPlugins}
          rehypePlugins={
            policy.renderImages ? imageReaderRehypePlugins : readerRehypePlugins
          }
          translations={{ copyCode: m.markdown_reader_copy_code() }}
          urlTransform={readerUrlTransform}
        >
          {content}
        </Streamdown>
      </div>
    </MarkdownReaderBoundary>
  );
}

interface MarkdownReaderBoundaryProps {
  children: ReactNode;
  content: string;
}

interface MarkdownReaderBoundaryState {
  failed: boolean;
}

export class MarkdownReaderBoundary extends Component<
  MarkdownReaderBoundaryProps,
  MarkdownReaderBoundaryState
> {
  state: MarkdownReaderBoundaryState = { failed: false };

  static getDerivedStateFromError(): MarkdownReaderBoundaryState {
    return { failed: true };
  }

  componentDidUpdate(previousProps: MarkdownReaderBoundaryProps) {
    if (this.state.failed && previousProps.content !== this.props.content) {
      this.setState({ failed: false });
    }
  }

  render() {
    if (this.state.failed) {
      return <MarkdownReaderPlaintextFallback content={this.props.content} />;
    }
    return this.props.children;
  }
}

export function MarkdownReaderPlaintextFallback({
  className,
  content,
}: Pick<MarkdownReaderProps, "className" | "content">) {
  return (
    <pre
      className={cn(
        "w-full min-w-0 max-w-full whitespace-pre-wrap break-words font-mono text-sm [overflow-wrap:anywhere]",
        className,
      )}
      data-markdown-reader-plaintext
    >
      {content}
    </pre>
  );
}

/** A diagram Mermaid cannot draw: the first line of its reason and its source. */
function MermaidSourceFallback({ chart, error }: MermaidErrorComponentProps) {
  const reason = error.split("\n", 1)[0]?.trim() ?? "";
  return (
    <div className="flex flex-col gap-2 p-2" data-markdown-reader-diagram-error>
      <p className="text-xs text-destructive [overflow-wrap:anywhere]">
        {m.markdown_reader_diagram_error({ reason })}
      </p>
      <pre className="overflow-x-auto rounded-md bg-muted p-2 font-mono text-xs">
        {chart}
      </pre>
    </div>
  );
}

interface HastNode {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

/** Parents where an image run may stand as a block among their children. */
const FLOW_PARENTS = new Set(["root", "li", "td", "th", "blockquote", "div"]);

/**
 * Images of a paragraph are blocks where they stand: each run of them
 * leaves the paragraph, which splits around it, and becomes one block the
 * policy shows. A block inside `<p>` is not valid HTML.
 */
function imageRuns() {
  return (tree: HastNode) => placeImageRuns(tree);
}

function placeImageRuns(node: HastNode): void {
  if (!node.children) return;
  node.children.forEach(placeImageRuns);
  const parent = node.type === "root" ? "root" : (node.tagName ?? "");
  if (!FLOW_PARENTS.has(parent)) return;
  const children: HastNode[] = [];
  for (const child of node.children) {
    if (isElement(child, "p") && child.children?.some(isImage)) {
      children.push(...splitParagraph(child));
    } else {
      children.push(child);
    }
  }
  node.children = groupImageRuns(children);
}

function splitParagraph(paragraph: HastNode): HastNode[] {
  const parts: HastNode[] = [];
  let text: HastNode[] = [];
  const flush = () => {
    if (text.some((child) => !isBlank(child))) {
      parts.push({ ...paragraph, children: trimBlank(text) });
    }
    text = [];
  };
  for (const child of groupImageRuns(paragraph.children ?? [])) {
    if (isImageRun(child)) {
      flush();
      parts.push(child);
    } else {
      text.push(child);
    }
  }
  flush();
  return parts;
}

/** Consecutive images, with only blank text or breaks between, as runs. */
function groupImageRuns(children: HastNode[]): HastNode[] {
  const grouped: HastNode[] = [];
  let run: HastNode[] = [];
  let between: HastNode[] = [];
  const flush = () => {
    if (run.length > 0) {
      grouped.push({
        type: "element",
        tagName: "div",
        properties: { dataMarkdownReaderImages: true },
        children: run,
      });
    }
    grouped.push(...between);
    run = [];
    between = [];
  };
  for (const child of children) {
    if (isImage(child)) {
      run.push(child);
      between = [];
    } else if (run.length > 0 && isBlank(child)) {
      between.push(child);
    } else {
      flush();
      grouped.push(child);
    }
  }
  flush();
  return grouped;
}

function imageRunOf(node: HastNode | undefined): MarkdownReaderImage[] | null {
  if (!node || !isImageRun(node)) return null;
  return (node.children ?? []).filter(isImage).map((image) => ({
    source: String(image.properties?.src ?? ""),
    alt: String(image.properties?.alt ?? ""),
  }));
}

function isElement(node: HastNode, tagName: string): boolean {
  return node.type === "element" && node.tagName === tagName;
}

function isImage(node: HastNode): boolean {
  return isElement(node, "img");
}

function isImageRun(node: HastNode): boolean {
  return (
    isElement(node, "div") &&
    node.properties?.dataMarkdownReaderImages !== undefined
  );
}

function isBlank(node: HastNode): boolean {
  return (
    isElement(node, "br") ||
    (node.type === "text" && (node.value ?? "").trim() === "")
  );
}

/** A paragraph part without the breaks and spaces at its edges. */
function trimBlank(children: HastNode[]): HastNode[] {
  let start = 0;
  let end = children.length;
  while (start < end && isBlank(children[start])) start += 1;
  while (end > start && isBlank(children[end - 1])) end -= 1;
  const trimmed = children.slice(start, end);
  const edge = (index: number, trim: (value: string) => string) => {
    const node = trimmed[index];
    if (node?.type === "text") {
      trimmed[index] = { ...node, value: trim(node.value ?? "") };
    }
  };
  edge(0, (value) => value.trimStart());
  edge(trimmed.length - 1, (value) => value.trimEnd());
  return trimmed;
}

type DocumentColorScheme = "dark" | "light";

/** The color scheme the app applied as a class on the document root. */
function useDocumentColorScheme(): DocumentColorScheme {
  return useSyncExternalStore(
    subscribeToDocumentColorScheme,
    readDocumentColorScheme,
    () => "light",
  );
}

function subscribeToDocumentColorScheme(onChange: () => void) {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributeFilter: ["class"] });
  return () => observer.disconnect();
}

function readDocumentColorScheme(): DocumentColorScheme {
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

/** URLs go to the policy as written; it alone decides what they open. */
const readerUrlTransform: UrlTransform = (url) => url.trim() || null;
