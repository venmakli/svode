import { useEffect, useState, useSyncExternalStore } from "react";
import { useSpace } from "@/features/space";
import {
  attachmentExists,
  localPathKind,
  readImagePreview,
  readPagePreview,
  type LocalPathKind,
  type PagePreview,
} from "../api/attachments";
import {
  attachmentKind,
  locateAttachment,
  type Attachment,
} from "../model/attachments";

/**
 * Badges check their files again when the window comes back, e.g. after a
 * file was deleted in the file manager, and when a send found one gone.
 */
let availabilityCheck = 0;
const availabilityListeners = new Set<() => void>();

/** Checks again whether the files of all badges are still there. */
export function recheckAttachments() {
  availabilityCheck += 1;
  for (const listener of availabilityListeners) listener();
}

function subscribeAvailabilityCheck(listener: () => void) {
  availabilityListeners.add(listener);
  if (availabilityListeners.size === 1) {
    window.addEventListener("focus", recheckAttachments);
  }
  return () => {
    availabilityListeners.delete(listener);
    if (availabilityListeners.size === 0) {
      window.removeEventListener("focus", recheckAttachments);
    }
  };
}

/** Whether the file is still there; null until first checked. */
export function useAttachmentAvailable(path: string): boolean | null {
  const check = useSyncExternalStore(
    subscribeAvailabilityCheck,
    () => availabilityCheck,
  );
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
  }, [path, check]);
  return state?.path === path ? state.available : null;
}

/**
 * What a path in agent text names: a file, a folder, or nothing (null);
 * undefined until first checked. Checked again with the badges.
 */
export function useLocalPathKind(
  path: string | null,
): LocalPathKind | null | undefined {
  const check = useSyncExternalStore(
    subscribeAvailabilityCheck,
    () => availabilityCheck,
  );
  const [state, setState] = useState<{
    path: string;
    kind: LocalPathKind | null;
  } | null>(null);
  useEffect(() => {
    if (!path) return;
    let cancelled = false;
    localPathKind(path)
      .then((kind) => {
        if (!cancelled) setState({ path, kind });
      })
      .catch(() => {
        if (!cancelled) setState({ path, kind: null });
      });
    return () => {
      cancelled = true;
    };
  }, [path, check]);
  if (!path) return null;
  return state?.path === path ? state.kind : undefined;
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
