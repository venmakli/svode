import {
  createElement,
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";

import {
  useActiveEntrySelection,
} from "@/features/entry/selection";
import { useSpace, selectActiveSpacePath } from "@/features/space";
import {
  resolveEditorAssetWebviewUrl,
  toEditorWebviewAssetUrl,
} from "../api/editor-media-api";
import {
  resolveEditorAssetContext,
  resolveEditorDocumentContext,
  type EditorAssetResolveContext,
  type ResolvedEditorDocumentContext,
} from "../lib/editor-asset-context";

const EXTERNAL = /^(https?:|data:|blob:|asset:|file:)/i;
const resolvedAssetUrlCache = new Map<string, string>();
const pendingAssetUrlResolutions = new Map<string, Promise<string>>();

const EditorAssetResolveReactContext =
  createContext<EditorAssetResolveContext | null>(null);

export function EditorAssetResolveProvider({
  children,
  value,
}: {
  children: ReactNode;
  value: EditorAssetResolveContext;
}) {
  return createElement(
    EditorAssetResolveReactContext.Provider,
    { value },
    children,
  );
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

  const promise = resolveEditorAssetWebviewUrl(url, projectPath, documentAbsPath)
    .then((webviewUrl) => {
      resolvedAssetUrlCache.set(key, webviewUrl);
      return webviewUrl;
    })
    .finally(() => {
      pendingAssetUrlResolutions.delete(key);
    });

  pendingAssetUrlResolutions.set(key, promise);
  return promise;
}

export function useEditorDocumentContext(): ResolvedEditorDocumentContext | null {
  const explicitContext = useContext(EditorAssetResolveReactContext);
  const { activeDocument, activeDocumentSpaceId } = useActiveEntrySelection();
  const { activeRootId, activeRootPath, rootSpaces, spaces } = useSpace(
    (state) => ({
      activeRootId: state.activeRootId,
      activeRootPath: state.activeRootPath,
      rootSpaces: state.rootSpaces,
      spaces: state.spaces,
    }),
  );

  const resolvedExplicitContext = resolveEditorAssetContext(
    explicitContext,
    activeRootId,
  );
  if (resolvedExplicitContext) return resolvedExplicitContext;

  return resolveEditorDocumentContext({
    activeRootId,
    documentPath: activeDocument,
    documentSpaceId: activeDocumentSpaceId,
    projectPath: activeRootPath,
    rootSpaces,
    spaces,
  });
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
  const context = useEditorDocumentContext();
  const projectPath = context?.projectPath ?? null;
  const documentAbsPath = context?.documentAbsPath ?? null;
  const spacePathFallback = useSpace(selectActiveSpacePath);
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
          if (!cancelled) setResolved(toEditorWebviewAssetUrl(absolute));
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
