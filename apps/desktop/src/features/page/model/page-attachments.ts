import type { PageDetailState } from "./types";

export function pageAttachmentOwnerPath(
  pagePath: string,
  detailState: PageDetailState | null,
): string | null {
  if (detailState?.form !== "folder") return null;
  const normalized = pagePath.replaceAll("\\", "/");
  if (!/\/readme\.md$/iu.test(normalized)) return null;
  const ownerPath = normalized.replace(/\/readme\.md$/iu, "");
  return ownerPath && ownerPath !== "." ? ownerPath : null;
}
