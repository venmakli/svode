import {
  Database,
  File,
  FileImage,
  FileText,
  Music,
  PanelsTopLeft,
  Video,
} from "lucide-react";

import type { AttachmentRow } from "../model/types";

export function AttachmentIcon({ row }: { row: AttachmentRow }) {
  const icon = row.icon?.trim();
  const Fallback =
    row.kind === "collection"
      ? Database
      : row.hasApp || row.kind === "app"
        ? PanelsTopLeft
        : row.kind !== "media"
          ? FileText
          : /^(png|jpg|jpeg|webp|gif|svg|avif|ico)$/u.test(row.format)
            ? FileImage
            : /^(mp3|wav|m4a|aac|flac|ogg|opus|wma|aiff)$/u.test(row.format)
              ? Music
              : /^(mp4|m4v|mov|webm|mkv|avi|wmv|mpg|mpeg|3gp)$/u.test(
                    row.format,
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
