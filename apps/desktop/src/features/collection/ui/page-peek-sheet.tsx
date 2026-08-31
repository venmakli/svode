import { useMemo, useState, type ReactNode } from "react";
import { Maximize2, Star, StarOff, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetTitle,
} from "@/components/ui/sheet";
import { cn } from "@/shared/lib/utils";
import type { Page } from "@/features/page";
import { PageDetailActions, PagePeekSurface } from "@/features/page/detail";
import { handleError } from "../hooks/error-feedback";
import { resolveLoadedPeekPage, usePagePeekLoader } from "../hooks";
import type {
  CollectionPeekSurfaceState,
  CollectionRouteState,
  PagePeekTarget,
} from "../model";
import type { CalendarScope } from "../model/calendar-types";
import { useOptionalCollectionDetailController } from "../app-shell";
import * as m from "@/paraglide/messages.js";

interface PagePeekSheetProps {
  readOnly: boolean;
  target: PagePeekTarget | null;
  spacePath: string;
  projectPath?: string | null;
  spaceId: string;
  onOpenChange: (open: boolean) => void;
  onOpenFullPage: (
    page: Page,
    spaceId?: string | null,
    viewName?: string | null,
    surfaceId?: CollectionPeekSurfaceState["surfaceId"],
  ) => void;
  onOpenPath: (path: string, spaceId?: string | null) => void;
  onDuplicatePage: (page: Page) => void;
  onDeletePage: (page: Page) => void;
  onConvertedPage: (page: Page, nested: boolean) => void;
  onSetTemplateDefault?: (slug: string | null) => Promise<void>;
  onDuplicateTemplate?: (page: Page) => Promise<void>;
  renderNested: (
    page: Page,
    actions: ReactNode,
    routeState: CollectionRouteState,
    surfaceState: CollectionPeekSurfaceState,
    sessionKey: string,
  ) => ReactNode;
}

export function PagePeekSheet({
  readOnly,
  target,
  spacePath,
  projectPath,
  spaceId,
  onOpenChange,
  onOpenFullPage,
  onOpenPath,
  onDuplicatePage,
  onDeletePage,
  onConvertedPage,
  onSetTemplateDefault,
  onDuplicateTemplate,
  renderNested,
}: PagePeekSheetProps) {
  const detailController = useOptionalCollectionDetailController();
  const open = Boolean(target);
  const effectiveSpacePath = target?.spacePath ?? spacePath;
  const effectiveProjectPath = target?.projectPath ?? projectPath;
  const effectiveSpaceId = target?.spaceId ?? spaceId;
  const {
    page,
    setPage,
    schemaResult,
    setSchemaResult,
    loadedTargetKey,
    pathHandoff,
    targetKey,
  } = usePagePeekLoader({
    target,
    spacePath: effectiveSpacePath,
    spaceId: effectiveSpaceId,
  });

  const contentClassName = useMemo(
    () =>
      cn(
        "gap-0 p-0 pt-2 pb-6 data-[side=right]:sm:max-w-none",
        "shadow-[-24px_0_60px_color-mix(in_oklch,black_20%,transparent)]",
      ),
    [],
  );

  const currentPage = resolveLoadedPeekPage(
    target,
    page,
    loadedTargetKey,
    targetKey,
  );
  const detailActions =
    currentPage && !target?.nested ? (
      <PagePeekActions
        page={currentPage}
        readOnly={readOnly}
        onDuplicatePage={onDuplicatePage}
        onDeletePage={onDeletePage}
        onConvertedPage={onConvertedPage}
        template={target?.template}
        onSetTemplateDefault={onSetTemplateDefault}
        onDuplicateTemplate={onDuplicateTemplate}
        spacePath={effectiveSpacePath}
        projectPath={effectiveProjectPath}
        spaceId={effectiveSpaceId}
      />
    ) : null;

  return (
    <Sheet
      open={open}
      onOpenChange={(nextOpen) => {
        if (nextOpen || !detailController) {
          onOpenChange(nextOpen);
          return;
        }
        void detailController.prepareForNavigation().then((canClose) => {
          if (canClose) {
            onOpenChange(false);
          }
        });
      }}
    >
      <SheetContent
        side="right"
        showCloseButton={false}
        overlayClassName="bg-black/25 backdrop-blur-none supports-backdrop-filter:backdrop-blur-none"
        className={contentClassName}
        style={{ width: "min(1120px, max(720px, 66vw), 94vw)" }}
      >
        <SheetTitle className="sr-only">
          {currentPage?.meta.title ?? m.collection_open_in_peek()}
        </SheetTitle>

        {target?.nested && currentPage ? (
          <NestedScopePeek
            key={targetKey ?? undefined}
            page={currentPage}
            sessionKey={targetKey ?? `${effectiveSpaceId}:${target.page.path}`}
            renderActions={({ surfaceId, viewName }) => {
              const detail = (
                <PagePeekActions
                  page={currentPage}
                  readOnly={readOnly}
                  onDuplicatePage={onDuplicatePage}
                  onDeletePage={onDeletePage}
                  onConvertedPage={onConvertedPage}
                  template={target.template}
                  onSetTemplateDefault={onSetTemplateDefault}
                  onDuplicateTemplate={onDuplicateTemplate}
                  spacePath={effectiveSpacePath}
                  projectPath={effectiveProjectPath}
                  spaceId={effectiveSpaceId}
                />
              );
              return {
                peek: (
                  <PagePeekControls
                    page={currentPage}
                    onOpenFullPage={(pageToOpen) =>
                      onOpenFullPage(
                        pageToOpen,
                        effectiveSpaceId,
                        viewName,
                        surfaceId,
                      )
                    }
                  />
                ),
                detail: target.template ? (
                  <div className="flex items-center gap-2">
                    <Badge variant="secondary">
                      {m.collection_template_badge()}
                    </Badge>
                    {detail}
                  </div>
                ) : (
                  detail
                ),
              };
            }}
            renderNested={renderNested}
          />
        ) : currentPage ? (
          <>
            <PeekTopBar>
              <PagePeekControls
                page={currentPage}
                onOpenFullPage={(pageToOpen) =>
                  onOpenFullPage(pageToOpen, effectiveSpaceId)
                }
              />
            </PeekTopBar>
            <PeekScrollSurface>
              <PagePeekSurface
                readOnly={readOnly}
                page={currentPage}
                schemaResult={schemaResult}
                spacePath={effectiveSpacePath}
                projectPath={effectiveProjectPath}
                spaceId={effectiveSpaceId}
                pagePathHandoff={pathHandoff}
                actions={detailActions}
                metadataBefore={
                  target?.template ? (
                    <Badge variant="secondary">
                      {m.collection_template_badge()}
                    </Badge>
                  ) : null
                }
                onOpenPath={onOpenPath}
                onPageChange={setPage}
                onSchemaChange={setSchemaResult}
              />
            </PeekScrollSurface>
          </>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

function NestedScopePeek({
  page,
  sessionKey,
  renderActions,
  renderNested,
}: {
  page: Page;
  sessionKey: string;
  renderActions: (state: {
    surfaceId: CollectionPeekSurfaceState["surfaceId"];
    viewName: string | null;
  }) => { peek: ReactNode; detail: ReactNode };
  renderNested: PagePeekSheetProps["renderNested"];
}) {
  const [viewName, setViewName] = useState<string | null>(null);
  const [calendarScope, setCalendarScope] = useState<CalendarScope | null>(
    null,
  );
  const [surfaceId, setSurfaceId] =
    useState<CollectionPeekSurfaceState["surfaceId"]>("readme");
  const routeState = useMemo<CollectionRouteState>(
    () => ({
      viewName,
      onViewNameChange: setViewName,
      calendarScope,
      onCalendarScopeChange: setCalendarScope,
    }),
    [calendarScope, viewName],
  );
  const actions = renderActions({ surfaceId, viewName });

  return (
    <>
      <PeekTopBar>{actions.peek}</PeekTopBar>
      <PeekScrollSurface>
        {renderNested(
          page,
          actions.detail,
          routeState,
          {
            surfaceId,
            onSurfaceIdChange: setSurfaceId,
          },
          sessionKey,
        )}
      </PeekScrollSurface>
    </>
  );
}

function PeekTopBar({ children }: { children: ReactNode }) {
  return (
    <div className="flex shrink-0 items-center justify-end px-2 pb-2">
      {children}
    </div>
  );
}

function PeekScrollSurface({ children }: { children: ReactNode }) {
  return (
    <div className="scrollbar-hide min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
      {children}
    </div>
  );
}

function PagePeekActions({
  page,
  readOnly,
  onDuplicatePage,
  onDeletePage,
  onConvertedPage,
  template,
  onSetTemplateDefault,
  onDuplicateTemplate,
  spacePath,
  projectPath,
  spaceId,
}: {
  page: Page;
  readOnly: boolean;
  onDuplicatePage: (page: Page) => void;
  onDeletePage: (page: Page) => void;
  onConvertedPage: (page: Page, nested: boolean) => void;
  template?: PagePeekTarget["template"];
  onSetTemplateDefault?: (slug: string | null) => Promise<void>;
  onDuplicateTemplate?: (page: Page) => Promise<void>;
  spacePath: string;
  projectPath?: string | null;
  spaceId: string;
}) {
  const templateDefaultAction =
    !readOnly && template && onSetTemplateDefault ? (
      template.isDefault ? (
        <DropdownMenuItem
          onClick={() => void onSetTemplateDefault(null).catch(handleError)}
        >
          <StarOff data-icon="inline-start" />
          {m.collection_template_unset_default()}
        </DropdownMenuItem>
      ) : (
        <DropdownMenuItem
          onClick={() =>
            void onSetTemplateDefault(template.slug).catch(handleError)
          }
        >
          <Star data-icon="inline-start" />
          {m.collection_template_set_default()}
        </DropdownMenuItem>
      )
    ) : null;

  return (
    <PageDetailActions
      page={page}
      spacePath={spacePath}
      projectPath={projectPath}
      spaceId={spaceId}
      onConverted={onConvertedPage}
      onDuplicatePage={(pageToDuplicate) => {
        if (template && onDuplicateTemplate) {
          void onDuplicateTemplate(pageToDuplicate).catch(handleError);
          return;
        }
        onDuplicatePage(pageToDuplicate);
      }}
      onDeletePage={onDeletePage}
      actionItemsBeforeDuplicate={templateDefaultAction}
      duplicateLabel={template ? m.collection_template_duplicate() : undefined}
      readOnly={readOnly}
    />
  );
}

function PagePeekControls({
  page,
  onOpenFullPage,
}: {
  page: Page;
  onOpenFullPage: (page: Page) => void;
}) {
  return (
    <div className="flex items-center gap-1">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-7 rounded-lg px-2 text-xs text-muted-foreground hover:text-foreground"
        onClick={() => onOpenFullPage(page)}
      >
        <Maximize2 data-icon="inline-start" />
        Full page
      </Button>
      <SheetClose asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="text-muted-foreground hover:text-foreground"
        >
          <X />
          <span className="sr-only">{m.settings_cancel()}</span>
        </Button>
      </SheetClose>
    </div>
  );
}
