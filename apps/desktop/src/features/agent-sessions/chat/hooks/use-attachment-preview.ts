import { useEffect, useState } from "react";
import { useSpace } from "@/features/space";
import {
  attachmentExists,
  readImagePreview,
  readPagePreview,
  type PagePreview,
} from "../api/attachments";
import {
  attachmentKind,
  locateAttachment,
  type Attachment,
} from "../model/attachments";

/** Whether the file is still there; null until checked. */
export function useAttachmentAvailable(path: string): boolean | null {
  const [state, setState] = useState<{ path: string; available: boolean } | null>(
    null,
  );
  useEffect(() => {
    let cancelled = false;
    attachmentExists(path)
      .then((available) => {
        if (!cancelled) setState({ path, available });
      })
      .catch(() => {
        if (!cancelled) setState({ path, available: false });
      });
    return () => {
      cancelled = true;
    };
  }, [path]);
  return state?.path === path ? state.available : null;
}

export type AttachmentPreview =
  | { state: "loading" }
  | { state: "image"; url: string }
  | { state: "page"; page: PagePreview }
  /** Nothing beyond name, path and type. */
  | { state: "plain" };

/** What the preview card shows, loaded while the card is open. */
export function useAttachmentPreview(
  attachment: Attachment,
  open: boolean,
): AttachmentPreview {
  const rootSpaces = useSpace((state) => state.rootSpaces);
  const spaces = useSpace((state) => state.spaces);
  const kind = attachmentKind(attachment.path);
  const location =
    kind === "page"
      ? locateAttachment(attachment.path, [...rootSpaces, ...spaces])
      : null;
  const spacePath = location?.spacePath ?? null;
  const pagePath = location?.path ?? null;
  const [preview, setPreview] = useState<{
    path: string;
    value: AttachmentPreview;
  } | null>(null);

  useEffect(() => {
    if (!open) return;
    const path = attachment.path;
    let cancelled = false;
    let url: string | null = null;
    const settle = (value: AttachmentPreview) => {
      if (!cancelled) setPreview({ path, value });
    };
    if (kind === "image") {
      readImagePreview(path)
        .then((blob) => {
          if (!blob) return settle({ state: "plain" });
          url = URL.createObjectURL(blob);
          settle({ state: "image", url });
        })
        .catch(() => settle({ state: "plain" }));
    } else if (spacePath && pagePath) {
      readPagePreview(spacePath, pagePath)
        .then((page) => settle({ state: "page", page }))
        .catch(() => settle({ state: "plain" }));
    } else {
      settle({ state: "plain" });
    }
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [attachment.path, kind, open, pagePath, spacePath]);

  return preview?.path === attachment.path ? preview.value : { state: "loading" };
}
