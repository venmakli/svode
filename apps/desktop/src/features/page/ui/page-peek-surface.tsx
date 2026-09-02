import {
  useCallback,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";
import { Separator } from "@/components/ui/separator";
import { PlateDocumentEditor } from "@/features/editor";
import { PropertyPanel } from "@/features/properties/panel";
import type { PageSchemaResult } from "@/features/properties";
import { useSpaceTreeSync } from "@/features/space";
import { detailPageHeaderClassName } from "@/shared/ui/page-layout";
import { isPageTreeMetaField, usePageFieldSave } from "../field-save";
import { propertyFieldSavePolicy } from "../property-field-save";
import type { Page, PageCover } from "../model";
import { handleError } from "../lib/errors";
import { PageIdentityHeader } from "./page-identity-header";
import { PageSystemFields } from "./page-system-fields";

interface PagePeekSurfaceProps {
  readOnly?: boolean;
  page: Page;
  schemaResult: PageSchemaResult | null;
  spacePath: string;
  projectPath?: string | null;
  spaceId: string;
  pagePathHandoff?: { previousPath: string; path: string } | null;
  actions?: ReactNode;
  metadataBefore?: ReactNode;
  onOpenPath: (path: string, spaceId?: string | null) => void;
  onPageChange: Dispatch<SetStateAction<Page | null>>;
  onSchemaChange: (result: PageSchemaResult | null) => void;
}

export function PagePeekSurface({
  readOnly = false,
  page,
  schemaResult,
  spacePath,
  projectPath,
  spaceId,
  pagePathHandoff = null,
  actions,
  metadataBefore,
  onOpenPath,
  onPageChange,
  onSchemaChange,
}: PagePeekSurfaceProps) {
  const updateField = usePagePeekFieldSave({
    spacePath,
    projectPath,
    spaceId,
    onPageChange,
    readOnly,
  });

  async function updateCover(cover: PageCover | null) {
    await updateField(page, "cover", cover);
  }

  return (
    <div className="flex min-h-full flex-col">
      <div className={detailPageHeaderClassName}>
        <PageIdentityHeader
          readOnly={readOnly}
          title={page.meta.title}
          icon={page.meta.icon}
          description={page.meta.description ?? ""}
          cover={page.meta.cover ?? null}
          projectPath={projectPath ?? null}
          spacePath={spacePath}
          pagePath={page.path}
          onTitleChange={(value) =>
            void updateField(page, "title", value, { flush: true }).catch(
              handleError,
            )
          }
          onIconChange={(value) =>
            void updateField(page, "icon", value).catch(handleError)
          }
          onDescriptionChange={(value) =>
            void updateField(page, "description", value).catch(handleError)
          }
          onCoverChange={(cover) => void updateCover(cover).catch(handleError)}
          onBodyFocus={() => undefined}
          actions={actions}
          metadata={
            <div className="flex flex-col items-end gap-1">
              {metadataBefore}
              <PageSystemFields meta={page.meta} />
            </div>
          }
          coverSize="compact"
        />

        {schemaResult && schemaResult.schema.columns.length > 0 ? (
          <div>
            <PropertyPanel
              readOnly={readOnly}
              spacePath={spacePath}
              projectPath={projectPath}
              spaceId={spaceId}
              filePath={page.path}
              pageLabel={page.meta.title}
              schemaResult={schemaResult}
              values={page.meta.extra ?? {}}
              mode="peek"
              onOpenPath={onOpenPath}
              onSchemaChange={onSchemaChange}
              onValueChange={async (field, value) => {
                const column = schemaResult.schema.columns.find(
                  (item) => item.name === field,
                );
                await updateField(page, field, value, {
                  policy: column ? propertyFieldSavePolicy(column) : undefined,
                });
              }}
            />
          </div>
        ) : null}
      </div>
      <Separator />
      <PlateDocumentEditor
        bodyOnly
        pageScroll
        documentPath={page.path}
        documentSpaceId={spaceId}
        spacePath={spacePath}
        projectPath={projectPath}
        bodyOnlyMeta={page.meta}
        initialPage={page}
        initialPageSpacePath={spacePath}
        documentPathHandoff={pagePathHandoff}
        readOnly={readOnly}
        onDocumentPathChange={(path) => {
          onPageChange((current) => (current ? { ...current, path } : current));
        }}
      />
    </div>
  );
}

function usePagePeekFieldSave({
  spacePath,
  projectPath,
  spaceId,
  onPageChange,
  readOnly,
}: {
  spacePath: string;
  projectPath?: string | null;
  spaceId: string;
  onPageChange: Dispatch<SetStateAction<Page | null>>;
  readOnly: boolean;
}) {
  const patchPageTreeMeta = useSpaceTreeSync(
    (state) => state.patchPageTreeMeta,
  );
  const reloadTreePathParents = useSpaceTreeSync(
    (state) => state.reloadTreePathParents,
  );
  const applyPageUpdate = useCallback(
    (pagePath: string, update: (page: Page) => Page) => {
      onPageChange((current) =>
        current && current.path === pagePath ? update(current) : current,
      );
    },
    [onPageChange],
  );

  const { save } = usePageFieldSave({
    spacePath,
    projectPath,
    applyPageUpdate,
    deferTitlePathAdoption: true,
    onSaved: (updated, context) => {
      if (isPageTreeMetaField(context.field)) {
        patchPageTreeMeta(
          spaceId,
          context.previousPage.path,
          updated.meta.title,
          updated.meta.icon,
          updated.meta.description ?? null,
        );
        if (updated.path !== context.previousPage.path) {
          void reloadTreePathParents(spaceId, [
            context.previousPage.path,
            updated.path,
          ]);
        }
      }
    },
  });
  return useCallback(
    (...args: Parameters<typeof save>) => {
      if (readOnly) return Promise.resolve();
      return save(...args);
    },
    [readOnly, save],
  );
}
