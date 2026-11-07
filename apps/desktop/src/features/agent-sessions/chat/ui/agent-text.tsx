import { useMemo, type ReactNode } from "react";
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
import type { AgentMediaSegmentDto, AgentSessionKeyDto } from "../api/chat";
import { useOpenAttachment } from "../hooks/use-attachment-opener";
import {
  recheckAttachments,
  useLocalPathKind,
} from "../hooks/use-attachment-preview";
import { usePathBase } from "../hooks/use-path-base";
import { attachmentOf, folderAttachment } from "../model/attachments";
import { agentMessageParts } from "../model/media";
import { withMediaImages } from "../model/text-media";
import {
  formatLineSuffix,
  inlineCodeReference,
  labelledReference,
  linkTarget,
  referenceName,
  type LocalReference,
} from "../model/text-paths";
import { AttachmentBadge } from "./attachment-badge";
import { ChatMediaView } from "./chat-media";
import { TextImages } from "./text-media";
import * as m from "@/paraglide/messages.js";

/**
 * An agent message with its media at their places in the text (`08` R2):
 * the text as markdown, the media as tiles, player rows and file cards.
 */
export function AgentMessageContent({
  session,
  itemId,
  text,
  media,
  streaming,
}: {
  session: AgentSessionKeyDto;
  itemId: string;
  text: string;
  media: readonly AgentMediaSegmentDto[];
  /** The agent is still writing it: its last line may grow. */
  streaming: boolean;
}) {
  if (media.length === 0) {
    return <AgentText text={text} streaming={streaming} />;
  }
  const parts = agentMessageParts(itemId, text, media);
  return (
    <div className="flex min-w-0 flex-col gap-3">
      {parts.map((part, index) =>
        part.type === "text" ? (
          <AgentText
            key={index}
            text={part.text}
            streaming={streaming && index === parts.length - 1}
          />
        ) : (
          <ChatMediaView key={index} session={session} media={part.media} />
        ),
      )}
    </div>
  );
}

/**
 * Markdown text of the agent (Stage 10 `08`, R3): a link or a path in
 * inline code to an existing local object opens it by the badge rule, a
 * folder in the file manager; a path in inline code and a link that names
 * only its target show the object as a badge (DF-321). `http(s)` opens in
 * the browser; anything else stays text. Images with a local path or
 * `data:` and `MEDIA:` lines are media at their place, external images
 * load only when asked. Nothing opens on its own.
 */
export function AgentText({
  text,
  streaming = false,
}: {
  text: string;
  /** The agent is still writing it: its last line may grow. */
  streaming?: boolean;
}) {
  const content = useMemo(
    () => withMediaImages(text, { complete: !streaming }),
    [text, streaming],
  );
  // Rendered as a stream whether or not the agent still writes it, so the
  // end of the turn keeps every block it drew.
  return (
    <MarkdownReader
      content={content}
      policy={agentTextPolicy}
      stream={streaming ? "growing" : "complete"}
    />
  );
}

/**
 * One policy for every text: the reader keeps its rendered blocks while the
 * content stays, so what a link resolves against is read inside it.
 */
const agentTextPolicy: MarkdownReaderPolicy = {
  renderLink: (href, children, label) => (
    <AgentTextLink href={href} label={label}>
      {children}
    </AgentTextLink>
  ),
  renderInlineCode: (code, element) => (
    <AgentInlineCode code={code}>{element}</AgentInlineCode>
  ),
  renderImages: (images) => <TextImages images={images} />,
};

function AgentTextLink({
  href,
  label,
  children,
}: {
  href: string;
  label: string;
  children: ReactNode;
}) {
  const base = usePathBase();
  const target = linkTarget(href, base);
  if (!target) return <span data-markdown-reader-blocked-link>{children}</span>;
  return target.kind === "web" ? (
    <WebLink url={target.url}>{children}</WebLink>
  ) : (
    <LocalLink
      key={target.reference.path}
      reference={target.reference}
      named={labelledReference(label, href, target.reference, base)}
    >
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

/**
 * A link to a local object; one whose label only names it is its badge, a
 * missing one is its text with the reason.
 */
function LocalLink({
  reference,
  named,
  children,
}: {
  reference: LocalReference;
  /** The object to show as a badge, when the label only names it. */
  named: LocalReference | null;
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
  if (named) return <ObjectBadge reference={named} kind={kind} onOpen={open} />;
  return (
    <Hint hint={shownPath}>
      <MarkdownReaderLink target={reference.path} onOpen={open}>
        {children}
      </MarkdownReaderLink>
    </Hint>
  );
}

/** Inline code naming an existing object is its badge; else it stays code. */
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
  return <ObjectBadge reference={reference} kind={kind} onOpen={open} />;
}

/**
 * The badge of an attachment (Stage 10 `04`) in place of the path: icon of
 * its kind, its name with the line suffix, the full path on hover. It
 * opens as the text does.
 */
function ObjectBadge({
  reference,
  kind,
  onOpen,
}: {
  reference: LocalReference;
  kind: ReturnType<typeof useLocalPathKind>;
  onOpen: () => void;
}) {
  const name = referenceName(reference);
  const attachment =
    kind === "directory"
      ? folderAttachment(reference.path, name)
      : attachmentOf(reference.path, name);
  return (
    <AttachmentBadge attachment={attachment} variant="outline" onOpen={onOpen} />
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
