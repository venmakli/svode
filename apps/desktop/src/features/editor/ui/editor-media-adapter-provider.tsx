import * as React from "react";

import {
  MediaAdapterProvider,
  type MediaAdapter,
} from "@/components/ui/media-adapter";

import {
  filesToFileList,
  openEditorMediaUrl,
  pickEditorMediaFiles,
} from "../api/editor-media-api";
import {
  EditorAssetResolveProvider,
  useResolvedAssetUrl,
} from "../hooks/use-resolved-asset-url";
import type { EditorAssetResolveContext } from "../lib/editor-asset-context";
import { getErrorMessage, useUploadFile } from "../hooks/use-upload-file";

const editorMediaAdapter: MediaAdapter = {
  filesToFileList,
  getErrorMessage,
  openUrl: (url) => openEditorMediaUrl(url),
  pickFiles: pickEditorMediaFiles,
  useResolvedUrl: useResolvedAssetUrl,
  useUploadFile,
};

export function EditorMediaAdapterProvider({
  children,
  documentPath,
  projectPath,
  spaceId,
  spacePath,
}: {
  children: React.ReactNode;
  documentPath: string | null;
  projectPath: string | null;
  spaceId: string | null;
  spacePath: string | null;
}) {
  const context = React.useMemo<EditorAssetResolveContext>(
    () => ({
      documentPath,
      projectPath,
      spaceId,
      spacePath,
    }),
    [documentPath, projectPath, spaceId, spacePath],
  );
  const adapter = React.useMemo<MediaAdapter>(
    () => ({
      ...editorMediaAdapter,
      openUrl: (url) => openEditorMediaUrl(url, context),
    }),
    [context],
  );

  return (
    <EditorAssetResolveProvider value={context}>
      <MediaAdapterProvider adapter={adapter}>{children}</MediaAdapterProvider>
    </EditorAssetResolveProvider>
  );
}
