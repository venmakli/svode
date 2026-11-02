import { useEffect, useRef } from "react";
import { Badge } from "@/components/ui/badge";
import { PeekSheet } from "@/shared/ui/peek-sheet";
import { keepLayerOpenOnEscape } from "@/shared/lib/escape-key";
import { pageNavigationItem, type Page } from "@/features/page";
import { keepsCollectionPropertyEditorOnEscape } from "@/features/properties/panel";
import { useSpace } from "@/features/space";
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
    <PeekSheet
      open={Boolean(target)}
      title={target?.page.meta.title ?? m.collection_open_in_peek()}
      onRequestClose={() => void leave(() => close(), "close")}
      onEscapeKeyDown={(event) => {
        // Esc in the title or in a property cancels its edit and keeps the
        // peek open.
        if (
          (event.target instanceof HTMLElement &&
            event.target.matches("[data-page-title-input]:not([readonly])")) ||
          keepsCollectionPropertyEditorOnEscape(event.target)
        )
          keepLayerOpenOnEscape(event);
      }}
    >
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
            dismiss: close,
            metadataBefore: target.template ? (
              <Badge variant="secondary">{m.collection_template_badge()}</Badge>
            ) : null,
            renderHeaderActions: (page, readOnly) => (
              <>
                <PagePeekActions
                  {...props}
                  page={page}
                  readOnly={readOnly}
                  spacePath={spacePath}
                  spaceId={spaceId}
                  projectPath={projectPath}
                  template={target.template}
                />
                {target.focusTitle && page.path === target.page.path ? (
                  <PeekTitleFocus />
                ) : null}
              </>
            ),
            onExpand: (openFull) =>
              void leave(async () => {
                if (await openFull()) close();
              }, "expand"),
            onClose: () => void leave(() => close(), "close"),
          })
        : null}
    </PeekSheet>
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
  const activeRootId = useSpace((state) => state.activeRootId);

  return (
    <PageDetailActions
      page={page}
      menuKind={
        template
          ? { kind: "template", isDefault: template.isDefault }
          : { kind: detail.schemaResult ? "collection-item" : "page" }
      }
      pinItem={
        template ? null : pageNavigationItem(page, spaceId, activeRootId)
      }
      onSetTemplateDefault={
        template && onSetTemplateDefault
          ? (isDefault) =>
              onSetTemplateDefault(isDefault ? template.slug : null).catch(
                handleError,
              )
          : undefined
      }
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
      readOnly={readOnly}
    />
  );
}

/** Renames the item opened in peek for it: focuses its title once read. */
function PeekTitleFocus() {
  const { requestTitleFocus, status } = usePageDetailContext();
  const requestedRef = useRef(false);
  useEffect(() => {
    if (requestedRef.current || status !== "ready") return;
    requestedRef.current = true;
    requestTitleFocus();
  }, [requestTitleFocus, status]);
  return null;
}
