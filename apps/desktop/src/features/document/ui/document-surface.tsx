import { useMemo, useState, type FormEvent, type ReactNode } from "react";
import { FileText, FileWarning, KeyRound, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import {
  ExternalOpenButton,
  OpenWithControl,
  useExternalOpenGroup,
  type ExternalOpenBinding,
  type OpenWithGroup,
} from "@/features/external-open";
import * as m from "@/paraglide/messages.js";
import { PeekIdentity, PeekTopBar } from "@/shared/ui/peek-top-bar";

import { useDocumentSession } from "../hooks/use-document-session";
import {
  documentPartCount,
  normalizeRuntimePath,
  type DocumentFailure,
  type DocumentTarget,
} from "../model/types";
import { DocumentDetailsPopover } from "./document-details-popover";
import { DocxViewer } from "../docx/docx-viewer";
import { PdfViewer } from "../pdf/pdf-viewer";
import { XlsxViewer } from "../xlsx/xlsx-viewer";
import { PptxViewer } from "../pptx/pptx-viewer";

export function DocumentSurface({
  onClose,
  onOpenFullPage,
  path,
  projectPath,
  spaceId,
  spacePath,
  renderMainHeader,
}: {
  /** Shows the document in a peek, with the peek top bar ending in ×. */
  onClose?: () => void;
  onOpenFullPage?: () => void;
  path: string;
  projectPath: string;
  spaceId: string | null;
  spacePath: string;
  /** Outside a peek, hands the top bar elements to the main header. */
  renderMainHeader?: (header: {
    objectActions?: ReactNode;
    viewTools?: ReactNode;
    openWith: OpenWithGroup;
  }) => ReactNode;
}) {
  const target = useMemo<DocumentTarget>(
    () => ({
      path,
      projectPath,
      spaceId:
        normalizeRuntimePath(projectPath) === normalizeRuntimePath(spacePath)
          ? null
          : spaceId,
      spacePath,
    }),
    [path, projectPath, spaceId, spacePath],
  );
  const session = useDocumentSession(target);
  const title = documentDisplayName(path);
  const openFullPage = onOpenFullPage
    ? async () => {
        await session.prepareFullPageHandoff();
        onOpenFullPage();
      }
    : undefined;
  const openWith = useExternalOpenGroup(session.externalOpen);
  const info = session.source ? (
    <DocumentDetailsPopover
      source={session.source}
      parts={documentPartCount(session.state)}
    />
  ) : undefined;
  const renderTopBar = (viewTools?: ReactNode) =>
    onClose ? (
      <PeekTopBar
        identity={<PeekIdentity icon={<FileText />} name={title} />}
        info={info}
        viewTools={viewTools}
        openWith={<OpenWithControl groups={[openWith]} />}
        onExpand={openFullPage}
        onClose={onClose}
      />
    ) : (
      renderMainHeader?.({ objectActions: info, viewTools, openWith })
    );

  if (session.state.phase === "ready") {
    if (session.state.format === "pptx") {
      return (
        <PptxViewer
          externalOpenError={session.externalOpenError}
          onRegisterRendererDisposer={session.registerRendererDisposer}
          onRenderError={session.reportRendererError}
          onViewStateChange={session.updateViewState}
          presentation={session.state.presentation}
          renderTopBar={renderTopBar}
          viewState={session.viewState}
        />
      );
    }
    if (session.state.format === "xlsx") {
      return (
        <XlsxViewer
          externalOpenError={session.externalOpenError}
          onRegisterRendererDisposer={session.registerRendererDisposer}
          onRenderError={session.reportRendererError}
          onViewStateChange={session.updateViewState}
          renderTopBar={renderTopBar}
          title={title}
          viewState={session.viewState}
          workbook={session.state.workbook}
        />
      );
    }
    if (session.state.format === "docx") {
      return (
        <DocxViewer
          docx={session.state.docx}
          externalOpenError={session.externalOpenError}
          onRegisterRendererDisposer={session.registerRendererDisposer}
          onRenderError={session.reportRendererError}
          onViewStateChange={session.updateViewState}
          renderTopBar={renderTopBar}
          viewState={session.viewState}
        />
      );
    }
    return (
      <PdfViewer
        externalOpenError={session.externalOpenError}
        onRenderError={session.reportRendererError}
        onViewStateChange={session.updateViewState}
        pdf={session.state.pdf}
        renderTopBar={renderTopBar}
        title={title}
        viewState={session.viewState}
      />
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      {renderTopBar()}
      {session.state.phase === "loading" ? (
        <DocumentLoadingState progress={session.state.progress} />
      ) : session.state.phase === "password" ? (
        <DocumentPasswordState
          incorrect={session.state.incorrect}
          externalOpen={session.externalOpen}
          onSubmit={session.submitPassword}
        />
      ) : (
        <DocumentFailureState
          failure={session.state.failure}
          externalOpen={session.externalOpen}
          onRetry={session.retry}
        />
      )}
      {session.externalOpenError ? (
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

function DocumentLoadingState({ progress }: { progress: number }) {
  return (
    <div
      className="flex min-h-0 flex-1 flex-col items-center justify-center gap-5 px-8 py-12"
      aria-label={m.document_loading()}
    >
      <div className="flex w-full max-w-md flex-col gap-4">
        <Skeleton className="mx-auto size-12 rounded-xl" />
        <Skeleton className="mx-auto h-5 w-48" />
        <Progress
          value={Math.round(progress * 100)}
          aria-label={m.document_loading_progress()}
        />
      </div>
    </div>
  );
}

function DocumentPasswordState({
  incorrect,
  externalOpen,
  onSubmit,
}: {
  incorrect: boolean;
  externalOpen: ExternalOpenBinding;
  onSubmit(password: string): void;
}) {
  const [password, setPassword] = useState("");
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (password) onSubmit(password);
  };
  return (
    <Empty className="h-full border-0">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <KeyRound />
        </EmptyMedia>
        <EmptyTitle>{m.document_password_title()}</EmptyTitle>
        <EmptyDescription>
          {incorrect
            ? m.document_password_incorrect()
            : m.document_password_description()}
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <form className="flex w-full flex-col gap-3" onSubmit={submit}>
          <FieldGroup>
            <Field data-invalid={incorrect || undefined}>
              <FieldLabel htmlFor="document-password">
                {m.document_password_label()}
              </FieldLabel>
              <Input
                id="document-password"
                aria-invalid={incorrect || undefined}
                autoComplete="current-password"
                autoFocus
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </Field>
          </FieldGroup>
          <div className="flex justify-center gap-2">
            <Button type="submit" disabled={!password}>
              {m.document_password_submit()}
            </Button>
            <ExternalOpenButton {...externalOpen} presentation="text" />
          </div>
        </form>
      </EmptyContent>
    </Empty>
  );
}

function DocumentFailureState({
  failure,
  externalOpen,
  onRetry,
}: {
  failure: DocumentFailure;
  externalOpen: ExternalOpenBinding;
  onRetry(): void;
}) {
  const externalOnly = failure.kind === "external_only";
  return (
    <Empty className="h-full border-0">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <FileWarning />
        </EmptyMedia>
        <EmptyTitle>{failureTitle(failure)}</EmptyTitle>
        <EmptyDescription>{failureDescription(failure)}</EmptyDescription>
      </EmptyHeader>
      <EmptyContent className="flex-row justify-center">
        {externalOnly ? (
          <ExternalOpenButton
            {...externalOpen}
            presentation="text"
            variant="default"
          />
        ) : (
          <Button type="button" onClick={onRetry}>
            <RefreshCw data-icon="inline-start" />
            {m.attachments_retry()}
          </Button>
        )}
        {!externalOnly ? (
          <ExternalOpenButton {...externalOpen} presentation="text" />
        ) : null}
      </EmptyContent>
    </Empty>
  );
}

function failureTitle(failure: DocumentFailure) {
  switch (failure.kind) {
    case "external_only":
      return m.document_external_only_title();
    case "malformed":
      return m.document_malformed_title();
    case "resource_limit":
      return m.document_resource_limit_title();
    case "source_changed":
      return m.document_source_changed_title();
    case "source_missing":
      return m.document_source_missing_title();
    case "renderer_error":
      return m.document_renderer_error_title();
  }
}

function failureDescription(failure: DocumentFailure) {
  switch (failure.kind) {
    case "external_only":
      return m.document_external_only_description();
    case "malformed":
      return m.document_malformed_description();
    case "resource_limit":
      return m.document_resource_limit_description();
    case "source_changed":
      return m.document_source_changed_description();
    case "source_missing":
      return m.document_source_missing_description();
    case "renderer_error":
      return m.document_renderer_error_description();
  }
}

function documentDisplayName(path: string) {
  return path.replaceAll("\\", "/").split("/").at(-1) ?? path;
}
