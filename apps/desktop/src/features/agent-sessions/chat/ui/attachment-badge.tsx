import { useState } from "react";
import { File, FileText, FileX, Image } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/components/ui/hover-card";
import { cn } from "@/shared/lib/utils";
import {
  useAttachmentAvailable,
  useAttachmentPreview,
} from "../hooks/use-attachment-preview";
import { useOpenAttachment } from "../hooks/use-attachment-opener";
import {
  attachmentKind,
  fileExtension,
  type Attachment,
  type AttachmentKind,
} from "../model/attachments";
import * as m from "@/paraglide/messages.js";

/**
 * An attachment in the composer or a user message: icon and name. Hover
 * previews it, a click opens it; a file that is gone is marked and opens
 * nothing.
 */
export function AttachmentBadge({
  attachment,
  variant = "secondary",
  className,
}: {
  attachment: Attachment;
  variant?: "secondary" | "outline";
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const available = useAttachmentAvailable(attachment.path);
  const openAttachment = useOpenAttachment();
  const kind = attachmentKind(attachment.path);
  const missing = available === false;
  const Icon = missing ? FileX : KIND_ICONS[kind];

  return (
    <HoverCard open={open} onOpenChange={setOpen} openDelay={300}>
      <HoverCardTrigger asChild>
        <Badge
          asChild
          variant={variant}
          className={cn(
            "mx-0.5 h-5 max-w-56 cursor-pointer align-middle font-normal",
            missing && "cursor-default text-muted-foreground line-through",
            className,
          )}
        >
          <button
            type="button"
            aria-label={
              missing
                ? m.sessions_chat_attachment_unavailable_label({
                    name: attachment.name,
                  })
                : attachment.name
            }
            onClick={() => {
              if (available !== false) openAttachment?.(attachment);
            }}
          >
            <Icon data-icon="inline-start" />
            <span className="truncate">{attachment.name}</span>
          </button>
        </Badge>
      </HoverCardTrigger>
      <HoverCardContent className="w-72" align="start">
        {open && (
          <AttachmentPreviewCard
            attachment={attachment}
            kind={kind}
            missing={missing}
          />
        )}
      </HoverCardContent>
    </HoverCard>
  );
}

/** An image the agent replayed without a file: nothing to open. */
export function ImageMark({ name }: { name: string | null }) {
  return (
    <Badge variant="outline" className="mx-0.5 align-middle font-normal">
      <Image data-icon="inline-start" />
      {name ?? m.sessions_chat_attachment_image()}
    </Badge>
  );
}

const KIND_ICONS: Record<AttachmentKind, typeof File> = {
  page: FileText,
  image: Image,
  file: File,
};

function AttachmentPreviewCard({
  attachment,
  kind,
  missing,
}: {
  attachment: Attachment;
  kind: AttachmentKind;
  missing: boolean;
}) {
  const preview = useAttachmentPreview(attachment, !missing);
  return (
    <div className="flex flex-col gap-2 text-sm">
      {preview.state === "image" && (
        <img
          src={preview.url}
          alt={attachment.name}
          className="max-h-40 w-full rounded-md object-contain"
        />
      )}
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="truncate font-medium">
          {preview.state === "page" && preview.page.title
            ? preview.page.title
            : attachment.name}
        </span>
        {preview.state === "page" &&
          preview.page.lines.map((line, index) => (
            <span key={index} className="line-clamp-2 text-muted-foreground">
              {line}
            </span>
          ))}
        <span className="truncate text-xs text-muted-foreground">
          {attachment.path}
        </span>
        <span className="text-xs text-muted-foreground">
          {missing
            ? m.sessions_chat_attachment_unavailable()
            : kindLabel(kind, attachment.path)}
        </span>
      </div>
    </div>
  );
}

function kindLabel(kind: AttachmentKind, path: string): string {
  if (kind === "page") return m.sessions_chat_attachment_page();
  if (kind === "image") return m.sessions_chat_attachment_image();
  const extension = fileExtension(path);
  return extension
    ? m.sessions_chat_attachment_file_type({ type: extension.toUpperCase() })
    : m.sessions_chat_attachment_file();
}
