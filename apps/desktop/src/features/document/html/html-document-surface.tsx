import { lazy, Suspense, useState, type ReactNode } from "react";
import { FileText, FileWarning, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  ExternalOpenButton,
  OpenWithControl,
  useExternalOpenGroup,
  type ExternalOpenBinding,
  type OpenWithGroup,
} from "@/features/external-open";
import * as m from "@/paraglide/messages.js";
import { PeekIdentity, PeekTopBar } from "@/shared/ui/peek-top-bar";

import type { DocumentTarget } from "../model/types";
import { DocumentDetailsPopover } from "../ui/document-details-popover";
import type { HtmlDocumentRefusal } from "./html-document-api";
import {
  useHtmlDocument,
  useHtmlSource,
  type HtmlSourceState,
} from "./use-html-document";

type HtmlView = "preview" | "source";

// The highlighter loads only when the source is asked for.
const HtmlSourceView = lazy(async () => ({
  default: (await import("./html-source-view")).HtmlSourceView,
}));

/**
 * An HTML Document (Stage 11 `06`): the live page on its own origin, or its
 * read-only source. Every opening starts with the page.
 */
export function HtmlDocumentSurface({
  target,
  title,
  changes,
  onClose,
  onOpenFullPage,
  renderMainHeader,
}: {
  target: DocumentTarget;
  title: string;
  changes?: ReactNode;
  onClose?: () => void;
  onOpenFullPage?: () => void;
  renderMainHeader?: (header: {
    objectActions?: ReactNode;
    viewTools?: ReactNode;
    openWith: OpenWithGroup;
  }) => ReactNode;
}) {
  const page = useHtmlDocument(target);
  const [view, setView] = useState<HtmlView>("preview");
  const openWith = useExternalOpenGroup(page.externalOpen);
  const { state } = page;
  const refusedBySize =
    state.phase === "failed" &&
    state.failure.kind === "refused" &&
    state.failure.reason === "resource_limit";
  const canView = state.phase === "ready" || refusedBySize;
  const shownView: HtmlView = canView ? view : "preview";

  const info = page.source ? (
    <DocumentDetailsPopover
      source={page.source}
      parts={null}
      path={target.path}
    />
  ) : undefined;
  const viewTools = canView ? (
    <>
      <ToggleGroup
        type="single"
        size="sm"
        variant="outline"
        value={shownView}
        onValueChange={(next) => {
          if (next === "preview" || next === "source") setView(next);
        }}
        aria-label={m.html_document_view()}
      >
        <ToggleGroupItem value="preview">
          {m.html_document_preview()}
        </ToggleGroupItem>
        <ToggleGroupItem value="source">
          {m.html_document_source()}
        </ToggleGroupItem>
      </ToggleGroup>
      {shownView === "preview" && state.phase === "ready" ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              aria-label={m.html_document_reload()}
              onClick={page.reload}
            >
              <RefreshCw />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{m.html_document_reload()}</TooltipContent>
        </Tooltip>
      ) : null}
    </>
  ) : undefined;

  const topBar = onClose ? (
    <PeekTopBar
      identity={<PeekIdentity icon={<FileText />} name={title} />}
      info={info}
      viewTools={viewTools}
      changes={changes}
      openWith={<OpenWithControl groups={[openWith]} />}
      onExpand={onOpenFullPage}
      onClose={onClose}
    />
  ) : (
    renderMainHeader?.({ objectActions: info, viewTools, openWith })
  );

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      {topBar}
      <div className="relative min-h-0 flex-1 overflow-hidden">
        {shownView === "source" ? (
          <HtmlSourceBody
            target={target}
            page={page}
            refusedBySize={refusedBySize}
          />
        ) : state.phase === "failed" ? (
          state.failure.kind === "missing" ? (
            <HtmlMissingState path={target.path} />
          ) : (
            <HtmlRefusedState
              reason={state.failure.reason}
              externalOpen={page.externalOpen}
            />
          )
        ) : (
          <HtmlPreview
            title={title}
            viewportUrl={state.phase === "ready" ? state.viewportUrl : null}
            revision={state.phase === "ready" ? state.revision : 0}
          />
        )}
      </div>
      {page.externalOpenError ? (
        <p
          className="shrink-0 border-t px-4 py-2 text-sm text-destructive"
          role="alert"
        >
          {m.document_external_open_error()}
        </p>
      ) : null}
    </div>
  );
}

/** The page; a skeleton covers it until its first load only. */
function HtmlPreview({
  title,
  viewportUrl,
  revision,
}: {
  title: string;
  viewportUrl: string | null;
  revision: number;
}) {
  const [loadedUrl, setLoadedUrl] = useState<string | null>(null);
  const loaded = viewportUrl !== null && loadedUrl === viewportUrl;
  return (
    <>
      {viewportUrl ? (
        <iframe
          key={`${viewportUrl}:${revision}`}
          className="size-full border-0 bg-background"
          src={viewportUrl}
          title={m.html_document_frame_title({ name: title })}
          sandbox="allow-downloads allow-forms allow-modals allow-popups allow-same-origin allow-scripts"
          referrerPolicy="no-referrer"
          onLoad={() => setLoadedUrl(viewportUrl)}
        />
      ) : null}
      {loaded ? null : (
        <div
          className="absolute inset-0 flex flex-col gap-4 bg-background p-6"
          aria-label={m.html_document_loading()}
          data-html-document="loading"
        >
          <Skeleton className="h-8 w-1/3" />
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-4 w-1/2" />
          <Skeleton className="min-h-0 flex-1" />
        </div>
      )}
    </>
  );
}

function HtmlSourceBody({
  target,
  page,
  refusedBySize,
}: {
  target: DocumentTarget;
  page: ReturnType<typeof useHtmlDocument>;
  refusedBySize: boolean;
}) {
  const state = useHtmlSource(target, page.source, refusedBySize);
  const loading = (
    <div
      className="flex flex-col gap-2 p-4"
      aria-label={m.html_document_source_loading()}
    >
      {[0, 1, 2, 3, 4].map((line) => (
        <Skeleton key={line} className="h-4 w-full" />
      ))}
    </div>
  );
  if (state.phase === "ready") {
    return (
      <Suspense fallback={loading}>
        <HtmlSourceView
          path={target.path}
          text={state.text}
          version={page.source?.generation ?? ""}
        />
      </Suspense>
    );
  }
  if (state.phase === "loading") return loading;
  return (
    <Empty className="h-full border-0">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <FileWarning />
        </EmptyMedia>
        <EmptyTitle>{sourceFailureTitle(state)}</EmptyTitle>
      </EmptyHeader>
      <EmptyContent className="flex-row justify-center">
        <ExternalOpenButton
          {...page.externalOpen}
          presentation="text"
          variant="default"
        />
      </EmptyContent>
    </Empty>
  );
}

function sourceFailureTitle(
  state: Exclude<HtmlSourceState, { phase: "ready" | "loading" }>,
) {
  return state.phase === "too_large"
    ? m.html_document_source_too_large()
    : m.html_document_source_failed();
}

function HtmlMissingState({ path }: { path: string }) {
  return (
    <Empty className="h-full border-0">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <FileWarning />
        </EmptyMedia>
        <EmptyTitle>{m.html_document_missing_title()}</EmptyTitle>
        <EmptyDescription className="break-all">{path}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

function HtmlRefusedState({
  reason,
  externalOpen,
}: {
  reason: HtmlDocumentRefusal;
  externalOpen: ExternalOpenBinding;
}) {
  return (
    <Empty className="h-full border-0">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <FileWarning />
        </EmptyMedia>
        <EmptyTitle>{m.html_document_refused_title()}</EmptyTitle>
        <EmptyDescription>{refusalDescription(reason)}</EmptyDescription>
      </EmptyHeader>
      <EmptyContent className="flex-row justify-center">
        <ExternalOpenButton
          {...externalOpen}
          presentation="text"
          variant="default"
        />
      </EmptyContent>
    </Empty>
  );
}

function refusalDescription(reason: HtmlDocumentRefusal) {
  switch (reason) {
    case "symlink":
      return m.html_document_refused_symlink();
    case "path_unresolved":
      return m.html_document_refused_path();
    case "source_inaccessible":
      return m.html_document_refused_unreadable();
    case "resource_limit":
      return m.html_document_refused_size();
    case "unsupported_format":
      return m.html_document_refused_format();
  }
}
