import { useCallback, useMemo } from "react";

import type { CollectionCreateCapability } from "@/features/collection";
import { publishPageFilenameWarnings } from "@/features/page";
import { createPage } from "@/features/page/page-api";
import { useOpenPage } from "@/features/page/navigation";
import { usePageSurfaceSession } from "@/features/page/scope-surface";
import { useSpaceTreeSync } from "@/features/space";
import * as m from "@/paraglide/messages.js";

import {
  importAttachmentFile,
  pickAttachmentImportSource,
} from "../api/attachments-api";
import { createAttachmentsCreateCapability } from "../model/create";
import type { AttachmentOwnerRef } from "../model/types";

export function useAttachmentsCreate({
  owner,
  readOnly,
  refresh,
}: {
  owner: AttachmentOwnerRef;
  readOnly: boolean;
  refresh(): Promise<void>;
}): CollectionCreateCapability {
  const openPage = useOpenPage();
  const pageSurface = usePageSurfaceSession();
  const reloadTreePathParent = useSpaceTreeSync(
    (state) => state.reloadTreePathParent,
  );
  const createOwnerPage = useCallback(
    () =>
      pageSurface.runMutation(async () => {
        const page = await createPage({
          allocateUniqueTitle: true,
          parentPath:
            owner.identityKind === "page-directory" ? owner.ownerPath : null,
          projectPath: owner.projectPath,
          spacePath: owner.spacePath,
          title: String(m.editor_untitled()),
        });
        publishPageFilenameWarnings(page.warnings);
        await reloadTreePathParent(owner.spaceId, page.path);
        openPage(page.path, owner.spaceId);
      }),
    [openPage, owner, pageSurface, reloadTreePathParent],
  );

  const importOwnerFile = useCallback(async () => {
    const sourcePath = await pickAttachmentImportSource();
    if (!sourcePath) return;
    await pageSurface.runMutation(async () => {
      await importAttachmentFile({
        contentPath: owner.contentPath,
        projectPath: owner.projectPath,
        sourcePath,
        spaceId: owner.projectPath === owner.spacePath ? null : owner.spaceId,
      });
      await refresh();
    });
  }, [owner, pageSurface, refresh]);

  return useMemo(
    () =>
      createAttachmentsCreateCapability({
        hasDirectCollection: owner.hasDirectCollection,
        onCreatePage: createOwnerPage,
        onImportFile: importOwnerFile,
        state: readOnly
          ? { reason: m.attachments_read_only(), status: "disabled" }
          : { status: "idle" },
      }),
    [createOwnerPage, importOwnerFile, owner.hasDirectCollection, readOnly],
  );
}
