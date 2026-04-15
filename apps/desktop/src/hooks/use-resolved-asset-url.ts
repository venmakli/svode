import { convertFileSrc } from "@tauri-apps/api/core";
import { useWorkspaceStore, selectActiveSpacePath } from "@/stores/workspace";

/**
 * Resolve a URL stored in a Plate media node to something the webview can
 * actually load. For assets uploaded via `upload_asset`, the stored `url`
 * is a workspace-relative path like `.assets/<prefix>-name.png` — we join
 * it against the active workspace directory and pipe it through Tauri's
 * asset protocol so the file is served off disk.
 *
 * Non-relative URLs (http(s), blob:, data:, asset://) pass through unchanged,
 * so existing Plate features like URL embeds or ephemeral blob previews
 * keep working.
 */
export function resolveAssetUrl(url: string | undefined, spacePath: string): string | undefined {
  if (!url) return url;
  if (/^(https?:|data:|blob:|asset:|file:)/i.test(url)) return url;
  if (!spacePath) return url;
  // Normalize: strip any leading "./"
  const rel = url.replace(/^\.\//, "");
  // Join workspace dir + relative path. Use forward slashes — convertFileSrc
  // handles platform-specific normalization.
  const absolute = `${spacePath.replace(/\\/g, "/").replace(/\/$/, "")}/${rel}`;
  return convertFileSrc(absolute);
}

export function useResolvedAssetUrl(url: string | undefined): string | undefined {
  const spacePath = useWorkspaceStore(selectActiveSpacePath);
  return resolveAssetUrl(url, spacePath);
}
