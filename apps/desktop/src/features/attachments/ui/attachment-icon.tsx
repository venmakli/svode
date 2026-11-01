import {
  Database,
  File,
  FileImage,
  FileText,
  FolderOpen,
  Music,
  PanelsTopLeft,
  Video,
} from "lucide-react";

import type { AttachmentItem } from "../model/types";
import { attachmentPresentationKind } from "../model/presentation";

export function AttachmentIcon({ item }: { item: AttachmentItem }) {
  const icon = item.icon?.trim();
  const kind = attachmentPresentationKind(item);
  const Fallback =
    kind === "directory"
      ? FolderOpen
      : kind === "collection"
        ? Database
        : kind === "app"
          ? PanelsTopLeft
          : kind !== "media"
            ? FileText
            : /^(png|jpg|jpeg|webp|gif|svg|avif|ico)$/u.test(item.format)
              ? FileImage
              : /^(mp3|wav|m4a|aac|flac|ogg|opus|wma|aiff)$/u.test(item.format)
                ? Music
                : /^(mp4|m4v|mov|webm|mkv|avi|wmv|mpg|mpeg|3gp)$/u.test(
                      item.format,
                    )
                  ? Video
                  : File;
  return (
    <span
      className="inline-flex size-4 shrink-0 items-center justify-center"
      aria-hidden
    >
      {icon && !/\p{Cc}/u.test(icon) ? (
        <span className="leading-none">{icon}</span>
      ) : (
        <Fallback className="size-4 text-muted-foreground" />
      )}
    </span>
  );
}
