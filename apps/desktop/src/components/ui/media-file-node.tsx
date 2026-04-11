import * as React from 'react';

import type { TFileElement } from 'platejs';
import type { PlateElementProps } from 'platejs/react';

import { useMediaState } from '@platejs/media/react';
import { ResizableProvider } from '@platejs/resizable';
import { open as openPath } from '@tauri-apps/plugin-shell';
import { FileUp } from 'lucide-react';
import { PlateElement, useReadOnly, withHOC } from 'platejs/react';
import { toast } from 'sonner';

import { Caption, CaptionTextarea } from './caption';
import { useResolvedAssetUrl } from '@/hooks/use-resolved-asset-url';
import { getErrorMessage } from '@/hooks/use-upload-file';
import {
  selectActiveWorkspacePath,
  useWorkspaceStore,
} from '@/stores/workspace';

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
        // For workspace-relative assets, shell-open the absolute on-disk path
        // so the file launches in the OS default app. For external http(s)
        // URLs we also use openPath (it handles them).
        if (/^(https?:|data:|blob:|asset:|file:)/i.test(unsafeUrl)) {
          try {
            await openPath(unsafeUrl);
          } catch (err) {
            toast.error(getErrorMessage(err));
          }
          return;
        }
        const workspacePath = selectActiveWorkspacePath(
          useWorkspaceStore.getState()
        );
        if (!workspacePath) return;
        const rel = unsafeUrl.replace(/^\.\//, '');
        const absolute = `${workspacePath.replace(/\\/g, '/').replace(/\/$/, '')}/${rel}`;
        try {
          await openPath(absolute);
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

