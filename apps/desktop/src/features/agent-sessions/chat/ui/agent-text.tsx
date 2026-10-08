import type { ReactNode } from "react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  MarkdownReader,
  MarkdownReaderLink,
  type MarkdownReaderPolicy,
} from "@/shared/ui/markdown-reader";
import { openInSystem } from "../api/attachments";
import { useOpenAttachment } from "../hooks/use-attachment-opener";
import {
  recheckAttachments,
  useLocalPathKind,
} from "../hooks/use-attachment-preview";
import { usePathBase } from "../hooks/use-path-base";
import { attachmentOf } from "../model/attachments";
import {
  formatLineSuffix,
  inlineCodeReference,
  linkTarget,
  type LocalReference,
} from "../model/text-paths";
import * as m from "@/paraglide/messages.js";

/**
 * Markdown text of the agent (Stage 10 `08`, R3): a link or a path in
 * inline code to an existing local object opens it by the badge rule, a
 * folder in the file manager; `http(s)` opens in the browser; anything
 * else stays text. Nothing opens on its own.
 */
export function AgentText({ text }: { text: string }) {
  return <MarkdownReader content={text} policy={agentTextPolicy} />;
}

/**
 * One policy for every text: the reader keeps its rendered blocks while the
 * content stays, so what a link resolves against is read inside it.
 */
const agentTextPolicy: MarkdownReaderPolicy = {
  renderLink: (href, children) => (
    <AgentTextLink href={href}>{children}</AgentTextLink>
  ),
  renderInlineCode: (code, element) => (
    <AgentInlineCode code={code}>{element}</AgentInlineCode>
  ),
  resolveImageSource: () => null,
};

function AgentTextLink({
  href,
  children,
}: {
  href: string;
  children: ReactNode;
}) {
  const target = linkTarget(href, usePathBase());
  if (!target) return <span data-markdown-reader-blocked-link>{children}</span>;
  return target.kind === "web" ? (
    <WebLink url={target.url}>{children}</WebLink>
  ) : (
    <LocalLink key={target.reference.path} reference={target.reference}>
      {children}
    </LocalLink>
  );
}

function AgentInlineCode({
  code,
  children,
}: {
  code: string;
  children: ReactNode;
}) {
  const reference = inlineCodeReference(code, usePathBase());
  if (!reference) return children;
  return <InlineCodePath reference={reference}>{children}</InlineCodePath>;
}

function WebLink({ url, children }: { url: string; children: ReactNode }) {
  return (
    <Hint hint={url}>
      <MarkdownReaderLink target={url} onOpen={() => void openInSystem(url)}>
        {children}
      </MarkdownReaderLink>
    </Hint>
  );
}

/** A link to a local object; a missing one is its text with the reason. */
function LocalLink({
  reference,
  children,
}: {
  reference: LocalReference;
  children: ReactNode;
}) {
  const kind = useLocalPathKind(reference.path);
  const open = useOpenLocal(reference.path, kind);
  const shownPath = referenceText(reference);
  if (kind === undefined) return <span>{children}</span>;
  if (!open) {
    return (
      <Hint
        hint={shownPath}
        reason={m.sessions_chat_link_missing()}
        onOpen={recheckAttachments}
      >
        <span data-agent-text-missing-link={reference.path}>{children}</span>
      </Hint>
    );
  }
  return (
    <Hint hint={shownPath}>
      <MarkdownReaderLink target={reference.path} onOpen={open}>
        {children}
      </MarkdownReaderLink>
    </Hint>
  );
}

/** Inline code naming an existing object opens it; it still looks like code. */
function InlineCodePath({
  reference,
  children,
}: {
  reference: LocalReference;
  children: ReactNode;
}) {
  const kind = useLocalPathKind(reference.path);
  const open = useOpenLocal(reference.path, kind);
  if (!open) return children;
  return (
    <Hint hint={referenceText(reference)}>
      <button
        type="button"
        role="link"
        className="inline cursor-pointer border-0 bg-transparent p-0 align-baseline"
        data-agent-text-code-path={reference.path}
        onClick={open}
      >
        {children}
      </button>
    </Hint>
  );
}

/** A folder opens in the file manager, a file by the badge rule. */
function useOpenLocal(
  path: string,
  kind: ReturnType<typeof useLocalPathKind>,
): (() => void) | null {
  const openAttachment = useOpenAttachment();
  if (kind === "directory") return () => void openInSystem(path);
  if (kind === "file") return () => openAttachment?.(attachmentOf(path));
  return null;
}

function referenceText(reference: LocalReference): string {
  return reference.line
    ? `${reference.path}${formatLineSuffix(reference.line)}`
    : reference.path;
}

function Hint({
  hint,
  reason,
  onOpen,
  children,
}: {
  hint: string;
  reason?: string;
  /** A missing file is looked for again when its hint opens. */
  onOpen?: () => void;
  children: ReactNode;
}) {
  return (
    <Tooltip onOpenChange={(open) => open && onOpen?.()}>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent className="flex max-w-sm flex-col items-start gap-0.5 break-all">
        {reason && <span className="font-medium">{reason}</span>}
        <span>{hint}</span>
      </TooltipContent>
    </Tooltip>
  );
}
