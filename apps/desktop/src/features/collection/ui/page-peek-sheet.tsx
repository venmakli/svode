import { ChangesControl } from "@/features/changes";
import { Maximize2, Star, StarOff, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import type { Page } from "@/features/page";
import { PageDetailActions } from "@/features/page/detail";
import {
  usePageSurfaceSession,
  usePageDetailContext,
} from "@/features/page/scope-surface";
import {
  usePeekNavigation,
  type ScopePeekRenderer,
} from "@/features/scope-surfaces";
import { handleError } from "../hooks/error-feedback";
import type { PagePeekTarget } from "../model";
import * as m from "@/paraglide/messages.js";

interface PagePeekSheetProps {
  readOnly: boolean;
  target: PagePeekTarget | null;
  spacePath: string;
  projectPath?: string | null;
  spaceId: string;
  onOpenChange: (open: boolean) => void;
  onOpenPath: (path: string, spaceId?: string | null) => void;
  onDuplicatePage: (page: Page) => void;
  onDeletePage: (page: Page) => void;
  onConvertedPage: (page: Page, nested: boolean) => void;
  onSetTemplateDefault?: (slug: string | null) => Promise<void>;
  onDuplicateTemplate?: (page: Page) => Promise<void>;
  renderPeek: ScopePeekRenderer;
}

export function PagePeekSheet(props: PagePeekSheetProps) {
  const navigation = usePeekNavigation(
    props.target,
    (target) => `${target.spacePath ?? props.spacePath}:${target.page.path}`,
  );
  const { target, leave, registerNavigationGuard } = navigation;
  const spacePath = target?.spacePath ?? props.spacePath;
  const spaceId = target?.spaceId ?? props.spaceId;
  const projectPath = target?.projectPath ?? props.projectPath ?? spacePath;
  const close = () => {
    navigation.dismiss();
    props.onOpenChange(false);
  };
  return (
    <Sheet
      open={Boolean(target)}
      onOpenChange={(open) => {
        if (!open) void leave(() => close());
      }}
    >
      <SheetContent
        side="right"
        showCloseButton={false}
        overlayClassName="bg-black/25 backdrop-blur-none supports-backdrop-filter:backdrop-blur-none"
        className="gap-0 p-0 pt-2 pb-6 data-[side=right]:sm:max-w-none"
        style={{ width: "min(1120px, max(720px, 66vw), 94vw)" }}
      >
        <SheetTitle className="sr-only">
          {target?.page.meta.title ?? m.collection_open_in_peek()}
        </SheetTitle>
        {target
          ? props.renderPeek({
              path: target.page.path,
              spacePath,
              spaceId,
              projectPath,
              sessionKey: navigation.sessionKey,
              onContentPathChange: (path) =>
                navigation.adoptIdentity(`${spacePath}:${path}`),
              fallbackTitle: target.page.meta.title,
              registerNavigationGuard,
              metadataBefore: target.template ? (
                <Badge variant="secondary">
                  {m.collection_template_badge()}
                </Badge>
              ) : null,
              renderHeaderActions: (page, readOnly) => (
                <PagePeekActions
                  {...props}
                  page={page}
                  readOnly={readOnly}
                  spacePath={spacePath}
                  spaceId={spaceId}
                  projectPath={projectPath}
                  template={target.template}
                />
              ),
              renderActions: (openFull, owner) => (
                <div className="flex items-center gap-1">
                  {owner ? (
                    <ChangesControl
                      origin="peek"
                      target={{
                        kind: "page",
                        sourceShape:
                          owner.identityKind === "page-file"
                            ? "file"
                            : "directory",
                        spacePath,
                        projectPath,
                        path: owner.readmePath,
                        name: target.page.meta.title,
                      }}
                    />
                  ) : null}
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={!owner}
                    onClick={() =>
                      void leave(async () => {
                        if (await openFull()) close();
                      })
                    }
                  >
                    <Maximize2 data-icon="inline-start" />
                    Full page
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => void leave(() => close())}
                  >
                    <X />
                    <span className="sr-only">{m.settings_cancel()}</span>
                  </Button>
                </div>
              ),
            })
          : null}
      </SheetContent>
    </Sheet>
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
  const session = usePageSurfaceSession();
  const detail = usePageDetailContext();
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
      runMutation={session.runMutation}
      spacePath={spacePath}
      projectPath={projectPath}
      spaceId={spaceId}
      onConverted={(nextPage, nested) => {
        detail.adoptPage(nextPage);
        onConvertedPage(nextPage, nested);
      }}
      onDuplicatePage={(pageToDuplicate) => {
        if (template && onDuplicateTemplate) {
          void session
            .runMutation(() => onDuplicateTemplate(pageToDuplicate))
            .catch(handleError);
          return;
        }
        void session
          .prepareForNavigation()
          .then((ready) => {
            if (ready) onDuplicatePage(pageToDuplicate);
          })
          .catch(handleError);
      }}
      onDeletePage={(pageToDelete) => {
        void session
          .prepareForNavigation()
          .then((ready) => {
            if (ready) onDeletePage(pageToDelete);
          })
          .catch(handleError);
      }}
      actionItemsBeforeDuplicate={templateDefaultAction}
      duplicateLabel={template ? m.collection_template_duplicate() : undefined}
      readOnly={readOnly}
    />
  );
}
