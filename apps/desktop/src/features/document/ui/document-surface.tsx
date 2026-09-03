import { useMemo, useState, type FormEvent } from "react";
import {
  FileText,
  FileWarning,
  FolderOpen,
  KeyRound,
  Maximize2,
  RefreshCw,
  X,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import * as m from "@/paraglide/messages.js";

import { useDocumentSession } from "../hooks/use-document-session";
import {
  normalizeRuntimePath,
  type DocumentFailure,
  type DocumentTarget,
} from "../model/types";
import { PdfViewer } from "../pdf/pdf-viewer";

export function DocumentSurface({
  onClose,
  onOpenFullPage,
  path,
  projectPath,
  spaceId,
  spacePath,
}: {
  onClose?: () => void;
  onOpenFullPage?: () => void;
  path: string;
  projectPath: string;
  spaceId: string | null;
  spacePath: string;
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

  if (session.state.phase === "ready") {
    return (
      <PdfViewer
        externalOpenError={session.externalOpenError}
        onClose={onClose}
        onOpenExternal={session.openExternal}
        onOpenFullPage={openFullPage}
        onRenderError={session.reportRendererError}
        onViewStateChange={session.updateViewState}
        pdf={session.state.pdf}
        textIndex={session.state.textIndex}
        title={title}
        viewState={session.viewState}
      />
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <DocumentFrameToolbar
        onClose={onClose}
        onOpenExternal={session.openExternal}
        onOpenFullPage={openFullPage}
        title={title}
      />
      {session.state.phase === "loading" ? (
        <DocumentLoadingState progress={session.state.progress} />
      ) : session.state.phase === "password" ? (
        <DocumentPasswordState
          incorrect={session.state.incorrect}
          onOpenExternal={session.openExternal}
          onSubmit={session.submitPassword}
        />
      ) : (
        <DocumentFailureState
          failure={session.state.failure}
          onOpenExternal={session.openExternal}
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

function DocumentFrameToolbar({
  onClose,
  onOpenExternal,
  onOpenFullPage,
  title,
}: {
  onClose?: () => void;
  onOpenExternal(): void;
  onOpenFullPage?: () => void;
  title: string;
}) {
  return (
    <div className="flex shrink-0 items-center gap-2 border-b bg-background px-2 py-2">
      <FileText
        className="size-4 shrink-0 text-muted-foreground"
        aria-hidden="true"
      />
      <div
        className="min-w-0 flex-1 truncate text-sm font-medium"
        title={title}
      >
        {title}
      </div>
      <Badge variant="secondary">{m.document_read_only_preview()}</Badge>
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={onOpenExternal}
      >
        <FolderOpen data-icon="inline-start" />
        {m.document_open_externally()}
      </Button>
      {onOpenFullPage ? (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={onOpenFullPage}
        >
          <Maximize2 data-icon="inline-start" />
          {m.attachments_full_page()}
        </Button>
      ) : null}
      {onClose ? (
        <Button type="button" size="icon-sm" variant="ghost" onClick={onClose}>
          <X />
          <span className="sr-only">{m.settings_cancel()}</span>
        </Button>
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
      <div className="w-full max-w-md space-y-4">
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
  onOpenExternal,
  onSubmit,
}: {
  incorrect: boolean;
  onOpenExternal(): void;
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
        <form className="w-full space-y-3" onSubmit={submit}>
          <Field data-invalid={incorrect || undefined}>
            <FieldLabel htmlFor="document-password">
              {m.document_password_label()}
            </FieldLabel>
            <Input
              id="document-password"
              autoComplete="current-password"
              autoFocus
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </Field>
          <div className="flex justify-center gap-2">
            <Button type="submit" disabled={!password}>
              {m.document_password_submit()}
            </Button>
            <Button type="button" variant="outline" onClick={onOpenExternal}>
              {m.document_open_externally()}
            </Button>
          </div>
        </form>
      </EmptyContent>
    </Empty>
  );
}

function DocumentFailureState({
  failure,
  onOpenExternal,
  onRetry,
}: {
  failure: DocumentFailure;
  onOpenExternal(): void;
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
          <Button type="button" onClick={onOpenExternal}>
            <FolderOpen data-icon="inline-start" />
            {m.document_open_externally()}
          </Button>
        ) : (
          <Button type="button" onClick={onRetry}>
            <RefreshCw data-icon="inline-start" />
            {m.attachments_retry()}
          </Button>
        )}
        {!externalOnly ? (
          <Button type="button" variant="outline" onClick={onOpenExternal}>
            {m.document_open_externally()}
          </Button>
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
