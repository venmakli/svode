import * as React from "react";

import {
  MediaAdapterProvider,
  type MediaAdapter,
} from "@/components/ui/media-adapter";
import { useEntrySelectionStore } from "@/features/entry";
import { useSpaceStore } from "@/features/space/model";
import { resolveAssetAbsPath } from "@/platform/assets/assets-api";
import {
  filesToFileList,
  pickMediaFiles,
} from "@/platform/filesystem/native-file-picker";
import { openPath } from "@/platform/native/shell";

import { useResolvedAssetUrl } from "../hooks/use-resolved-asset-url";
import { getErrorMessage, useUploadFile } from "../hooks/use-upload-file";
import { joinAbs } from "../lib/doc-link-utils";

const EXTERNAL = /^(https?:|data:|blob:|asset:|file:)/i;

async function openEditorMediaUrl(url: string) {
  if (EXTERNAL.test(url)) {
    await openPath(url);
    return;
  }

  const projectPath = useSpaceStore.getState().activeRootPath;
  const { activeDocument, activeDocumentSpaceId } =
    useEntrySelectionStore.getState();

  if (!projectPath || !activeDocument) return;

  const { rootSpaces, spaces, activeRootId } = useSpaceStore.getState();
  const owner =
    !activeDocumentSpaceId || activeDocumentSpaceId === activeRootId
      ? (rootSpaces.find((root) => root.id === activeDocumentSpaceId)?.path ??
        projectPath)
      : spaces.find((space) => space.id === activeDocumentSpaceId)?.path;

  if (!owner) return;

  const documentAbsPath = activeDocument.startsWith("/")
    ? activeDocument
    : joinAbs(owner, activeDocument);
  const abs = await resolveAssetAbsPath(url, projectPath, documentAbsPath);
  await openPath(abs);
}

const editorMediaAdapter: MediaAdapter = {
  filesToFileList,
  getErrorMessage,
  openUrl: openEditorMediaUrl,
  pickFiles: (kind) => pickMediaFiles(kind),
  useResolvedUrl: useResolvedAssetUrl,
  useUploadFile,
};

export function EditorMediaAdapterProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <MediaAdapterProvider adapter={editorMediaAdapter}>
      {children}
    </MediaAdapterProvider>
  );
}
