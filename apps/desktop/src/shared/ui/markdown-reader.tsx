import {
  Component,
  useEffect,
  useMemo,
  useRef,
  type ComponentProps,
  type ReactNode,
} from "react";
import { code } from "@streamdown/code";
import {
  defaultRehypePlugins,
  Streamdown,
  type StreamdownProps,
  type UrlTransform,
} from "streamdown";

import { cn } from "@/shared/lib/utils";

type RehypePlugin = NonNullable<StreamdownProps["rehypePlugins"]>[number];

const readerPlugins = { code } as const;
const readerRehypePlugins: RehypePlugin[] = [urlKeepingSanitize()];

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

export interface MarkdownReaderPolicy {
  /** A link as the policy shows it; nothing leaves its text. */
  renderLink?(href: string, children: ReactNode): ReactNode;
  /** Inline code as the policy shows it; nothing leaves the code as is. */
  renderInlineCode?(code: string, element: ReactNode): ReactNode;
  resolveImageSource?(source: string): string | null;
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
  const components = useMemo<StreamdownProps["components"]>(
    () => ({
      a: ({ children, href }) => {
        const shown = href ? policy.renderLink?.(href, children) : null;
        return (
          shown ?? <span data-markdown-reader-blocked-link>{children}</span>
        );
      },
      img: ({ alt, src }) => {
        const resolvedSource =
          typeof src === "string" ? policy.resolveImageSource?.(src) : null;
        if (!resolvedSource) {
          return alt ? (
            <span data-markdown-reader-blocked-image>{alt}</span>
          ) : null;
        }

        return (
          <img
            alt={alt ?? ""}
            src={resolvedSource}
            loading="lazy"
            referrerPolicy="no-referrer"
          />
        );
      },
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
          controls={false}
          isAnimating={false}
          lineNumbers={false}
          linkSafety={{ enabled: false }}
          plugins={readerPlugins}
          rehypePlugins={readerRehypePlugins}
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

/** URLs go to the policy as written; it alone decides what they open. */
const readerUrlTransform: UrlTransform = (url) => url.trim() || null;
