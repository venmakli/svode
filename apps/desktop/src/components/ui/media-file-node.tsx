import * as React from 'react';

import type { TFileElement } from 'platejs';
import type { PlateElementProps } from 'platejs/react';

import { useMediaState } from '@platejs/media/react';
import { ResizableProvider } from '@platejs/resizable';
import { openPath } from "@/platform/native/shell";
import { FileUp } from 'lucide-react';
import { PlateElement, useReadOnly, withHOC } from 'platejs/react';
import { toast } from 'sonner';

import { Caption, CaptionTextarea } from './caption';
import { resolveAssetAbsPath } from '@/platform/assets/assets-api';
import { useResolvedAssetUrl } from '@/hooks/use-resolved-asset-url';
import { getErrorMessage } from '@/hooks/use-upload-file';
import { useLayoutStore } from '@/stores/layout';
import { useSpaceStore } from '@/stores/space';
import { joinAbs } from '@/features/editor/doc-link-utils';

export const FileElement = withHOC(
  ResizableProvider,
  function FileElement(props: PlateElementProps<TFileElement>) {
    const readOnly = useReadOnly();
    const { name, unsafeUrl } = useMediaState();
    const resolvedUrl = useResolvedAssetUrl(unsafeUrl);

    const handleOpen = React.useCallback(
      async (e: React.MouseEvent) => {
        e.preventDefault();
        if (!unsafeUrl) return;
        // For workspace-relative assets, ask the backend to resolve the abs
        // path through the same per-space resolver as the editor uses, then
        // shell-open. External URLs (http(s)/data/blob/file/asset) launch via
        // openPath directly.
        if (/^(https?:|data:|blob:|asset:|file:)/i.test(unsafeUrl)) {
          try {
            await openPath(unsafeUrl);
          } catch (err) {
            toast.error(getErrorMessage(err));
          }
          return;
        }
        const projectPath = useSpaceStore.getState().activeRootPath;
        const { activeDocument, activeDocumentSpaceId } =
          useLayoutStore.getState();
        if (!projectPath || !activeDocument) return;
        const { rootSpaces, spaces, activeRootId } = useSpaceStore.getState();
        const owner =
          !activeDocumentSpaceId || activeDocumentSpaceId === activeRootId
            ? rootSpaces.find((r) => r.id === activeDocumentSpaceId)?.path ??
              projectPath
            : spaces.find((s) => s.id === activeDocumentSpaceId)?.path;
        if (!owner) return;
        const documentAbsPath = activeDocument.startsWith('/')
          ? activeDocument
          : joinAbs(owner, activeDocument);
        try {
          const abs = await resolveAssetAbsPath(
            unsafeUrl,
            projectPath,
            documentAbsPath
          );
          await openPath(abs);
        } catch (err) {
          toast.error(getErrorMessage(err));
        }
      },
      [unsafeUrl]
    );

    return (
      <PlateElement className="my-px rounded-sm" {...props}>
        <a
          className="group relative m-0 flex cursor-pointer items-center rounded px-0.5 py-[3px] hover:bg-muted"
          contentEditable={false}
          download={name}
          href={resolvedUrl}
          onClick={handleOpen}
          rel="noopener noreferrer"
          role="button"
          target="_blank"
        >
          <div className="flex items-center gap-1 p-1">
            <FileUp className="size-5" />
            <div>{name}</div>
          </div>

          <Caption align="left">
            <CaptionTextarea
              className="text-left"
              readOnly={readOnly}
              placeholder="Write a caption..."
            />
          </Caption>
        </a>
        {props.children}
      </PlateElement>
    );
  }
);
