import { Component, useMemo, type ReactNode } from "react";
import { code } from "@streamdown/code";
import { harden } from "rehype-harden";
import {
  defaultRehypePlugins,
  Streamdown,
  type StreamdownProps,
  type UrlTransform,
} from "streamdown";

import { cn } from "@/shared/lib/utils";

const readerPlugins = { code } as const;
const readerRehypePlugins: NonNullable<StreamdownProps["rehypePlugins"]> = [
  defaultRehypePlugins.sanitize,
  [
    harden,
    {
      allowedImagePrefixes: ["*"],
      allowedLinkPrefixes: ["*"],
      allowDataImages: false,
      imageBlockPolicy: "text-only",
      linkBlockPolicy: "text-only",
    },
  ],
];

export interface MarkdownReaderPolicy {
  openLink(target: string): void | Promise<void>;
  resolveImageSource?(source: string): string | null;
  resolveLink(href: string): string | null;
}

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
  const components = useMemo<StreamdownProps["components"]>(
    () => ({
      a: ({ children, href }) => {
        const target = href ? policy.resolveLink(href) : null;
        if (!target) {
          return <span data-markdown-reader-blocked-link>{children}</span>;
        }

        return (
          <button
            type="button"
            role="link"
            className="inline cursor-pointer border-0 bg-transparent p-0 text-primary underline underline-offset-4"
            data-markdown-reader-link={target}
            onClick={() => void policy.openLink(target)}
          >
            {children}
          </button>
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
    }),
    [policy],
  );

  return (
    <MarkdownReaderBoundary content={content}>
      <div className={cn("min-w-0 text-sm", className)} data-markdown-reader>
        <Streamdown
          mode="static"
          animated={false}
          components={components}
          controls={false}
          isAnimating={false}
          lineNumbers={false}
          linkSafety={{ enabled: false }}
          plugins={readerPlugins}
          rehypePlugins={readerRehypePlugins}
          urlTransform={safeReaderUrlTransform}
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
        "min-w-0 whitespace-pre-wrap break-words font-mono text-sm",
        className,
      )}
      data-markdown-reader-plaintext
    >
      {content}
    </pre>
  );
}

const safeReaderUrlTransform: UrlTransform = (url) => {
  const normalized = url.trim();
  if (!normalized || /^(?:data|file|javascript|vbscript):/i.test(normalized)) {
    return null;
  }
  return normalized;
};
