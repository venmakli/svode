import { useEffect, useState } from "react";

import { useEntrySelectionStore } from "@/features/entry";
import { useSpaceStore, selectActiveSpacePath } from "@/features/space/model";
import { joinAbs } from "../lib/doc-link-utils";
import {
  resolveAssetAbsPath,
  toWebviewAssetUrl,
} from "@/platform/assets/assets-api";

const EXTERNAL = /^(https?:|data:|blob:|asset:|file:)/i;
const resolvedAssetUrlCache = new Map<string, string>();
const pendingAssetUrlResolutions = new Map<string, Promise<string>>();

interface ActiveContext {
  projectPath: string;
  documentAbsPath: string;
}

function assetCacheKey(
  url: string,
  projectPath: string,
  documentAbsPath: string,
) {
  return `${projectPath}\0${documentAbsPath}\0${url}`;
}

function resolveCachedAssetUrl(
  url: string,
  projectPath: string,
  documentAbsPath: string,
): Promise<string> {
  const key = assetCacheKey(url, projectPath, documentAbsPath);
  const cached = resolvedAssetUrlCache.get(key);
  if (cached) return Promise.resolve(cached);

  const pending = pendingAssetUrlResolutions.get(key);
  if (pending) return pending;

  const promise = resolveAssetAbsPath(url, projectPath, documentAbsPath)
    .then((abs) => {
      const webviewUrl = toWebviewAssetUrl(abs);
      resolvedAssetUrlCache.set(key, webviewUrl);
      return webviewUrl;
    })
    .finally(() => {
      pendingAssetUrlResolutions.delete(key);
    });

  pendingAssetUrlResolutions.set(key, promise);
  return promise;
}

function useActiveContext(): ActiveContext | null {
  const projectPath = useSpaceStore((s) => s.activeRootPath);
  const activeDocument = useEntrySelectionStore((s) => s.activeDocument);
  const activeDocumentSpaceId = useEntrySelectionStore(
    (s) => s.activeDocumentSpaceId,
  );
  const activeRootId = useSpaceStore((s) => s.activeRootId);
  const rootSpaces = useSpaceStore((s) => s.rootSpaces);
  const spaces = useSpaceStore((s) => s.spaces);

  if (!projectPath || !activeDocument) return null;

  const ownerId = activeDocumentSpaceId;
  let spacePath: string | undefined;
  if (!ownerId || ownerId === activeRootId) {
    spacePath = rootSpaces.find((r) => r.id === ownerId)?.path ?? projectPath;
  } else {
    spacePath = spaces.find((s) => s.id === ownerId)?.path;
  }
  if (!spacePath) return null;

  const documentAbsPath = activeDocument.startsWith("/")
    ? activeDocument
    : joinAbs(spacePath, activeDocument);
  return { projectPath, documentAbsPath };
}

/**
 * Resolve an asset URL stored in a Plate media node into a webview-loadable
 * URL. Pass-through for external URLs (http(s), data:, blob:, file:, asset:).
 * Otherwise routes through the backend `resolve_asset_url` IPC which uses the
 * same per-space resolver as document links — so cross-space references like
 * `../engineering/.assets/x.png` work out of the box.
 *
 * Returns `undefined` while the resolver is in flight; callers should treat
 * that as "render the broken image" (e.g. an LFS pointer file resolving to an
 * absolute path that the `<img>` element cannot load is the expected broken
 * state — no auto-pull).
 */
export function useResolvedAssetUrl(
  url: string | undefined,
): string | undefined {
  const context = useActiveContext();
  const projectPath = context?.projectPath ?? null;
  const documentAbsPath = context?.documentAbsPath ?? null;
  const spacePathFallback = useSpaceStore(selectActiveSpacePath);
  const [resolved, setResolved] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (!url) {
      let cancelled = false;
      queueMicrotask(() => {
        if (!cancelled) setResolved(undefined);
      });
      return () => {
        cancelled = true;
      };
    }
    if (EXTERNAL.test(url)) {
      let cancelled = false;
      queueMicrotask(() => {
        if (!cancelled) setResolved(url);
      });
      return () => {
        cancelled = true;
      };
    }
    if (!projectPath || !documentAbsPath) {
      // No active document yet — fall back to the workspace-relative join so
      // standalone previews (e.g. media preview dialog before the editor is
      // fully mounted) still render.
      if (spacePathFallback) {
        const rel = url.replace(/^\.\//, "");
        const absolute = `${spacePathFallback.replace(/\\/g, "/").replace(/\/$/, "")}/${rel}`;
        let cancelled = false;
        queueMicrotask(() => {
          if (!cancelled) setResolved(toWebviewAssetUrl(absolute));
        });
        return () => {
          cancelled = true;
        };
      } else {
        let cancelled = false;
        queueMicrotask(() => {
          if (!cancelled) setResolved(undefined);
        });
        return () => {
          cancelled = true;
        };
      }
    }
    let cancelled = false;
    resolveCachedAssetUrl(url, projectPath, documentAbsPath)
      .then((webviewUrl) => {
        if (!cancelled) setResolved(webviewUrl);
      })
      .catch((err) => {
        console.warn("resolve_asset_url failed:", err);
        if (!cancelled) setResolved(undefined);
      });
    return () => {
      cancelled = true;
    };
  }, [url, projectPath, documentAbsPath, spacePathFallback]);

  return resolved;
}
