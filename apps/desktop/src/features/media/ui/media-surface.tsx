import { useMemo, type ReactNode } from "react";
import { FileWarning, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
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

import { useMediaSession } from "../hooks/use-media-session";
import {
  mediaFamilyFromFormat,
  mediaDisplayName,
  mediaFormatFromPath,
  normalizeRuntimePath,
  type MediaFailure,
  type MediaTarget,
} from "../model/types";
import { MediaImageViewer } from "./media-image-viewer";
import { MediaPlaybackViewer } from "./media-playback-viewer";
import { MediaFamilyIcon, MediaMetadataPopover } from "./media-toolbar";

export function MediaSurface({
  changes,
  onClose,
  onOpenFullPage,
  path,
  projectPath,
  renderMainHeader,
  spaceId,
  spacePath,
}: {
  /** The "Changes" of the file in the peek top bar. */
  changes?: ReactNode;
  /** Shows the media file in a peek, with the peek top bar ending in ×. */
  onClose?: () => void;
  onOpenFullPage?: () => void;
  path: string;
  projectPath: string;
  /** Outside a peek, hands the top bar elements to the main header. */
  renderMainHeader?: (header: {
    objectActions?: ReactNode;
    viewTools?: ReactNode;
    openWith: OpenWithGroup;
  }) => ReactNode;
  spaceId: string | null;
  spacePath: string;
}) {
  const target = useMemo<MediaTarget>(
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
  const session = useMediaSession(target);
  const title = mediaDisplayName(path);
  const openFullPage = onOpenFullPage
    ? async () => {
        await session.prepareFullPageHandoff();
        onOpenFullPage();
      }
    : undefined;
  const openWith = useExternalOpenGroup(session.externalOpen);
  const loadedSource =
    session.state.phase === "loading" || session.state.phase === "ready"
      ? session.state.source
      : null;
  const info = loadedSource ? (
    <MediaMetadataPopover source={loadedSource} />
  ) : undefined;
  const renderTopBar = (viewTools?: ReactNode) =>
    onClose ? (
      <PeekTopBar
        identity={
          <PeekIdentity
            icon={
              <MediaFamilyIcon
                family={loadedSource?.family ?? mediaFamilyFromPath(path)}
              />
            }
            name={title}
          />
        }
        info={info}
        viewTools={viewTools}
        changes={changes}
        openWith={<OpenWithControl groups={[openWith]} />}
        onExpand={openFullPage}
        onClose={onClose}
      />
    ) : (
      renderMainHeader?.({ objectActions: info, viewTools, openWith })
    );

  if (session.state.phase === "loading" || session.state.phase === "ready") {
    const source = session.state.source;
    if (source.family !== "image") {
      return (
        <MediaPlaybackViewer
          key={source.capabilityToken}
          externalOpenError={session.externalOpenError}
          loading={session.state.phase === "loading"}
          onPlaybackError={session.reportPlaybackError}
          onReady={session.markReady}
          onRegisterExternalSuspender={session.registerExternalSuspender}
          onRegisterRendererDisposer={session.registerRendererDisposer}
          onViewStateChange={session.updateViewState}
          source={source}
          renderTopBar={renderTopBar}
          title={title}
          viewState={session.viewState}
        />
      );
    }
    return (
      <MediaImageViewer
        externalOpenError={session.externalOpenError}
        loading={session.state.phase === "loading"}
        onReady={(dimensions) => session.markReady(source, dimensions)}
        onRegisterExternalSuspender={session.registerExternalSuspender}
        onRegisterRendererDisposer={session.registerRendererDisposer}
        onRenderError={() => void session.reportImageError(source)}
        onViewStateChange={session.updateViewState}
        source={source}
        renderTopBar={renderTopBar}
        title={title}
        viewState={session.viewState}
      />
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      {renderTopBar()}
      {session.state.phase === "resolving" ? (
        <MediaLoadingState />
      ) : (
        <MediaFailureState
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
          {m.media_external_open_error()}
        </p>
      ) : null}
    </div>
  );
}

function mediaFamilyFromPath(path: string) {
  const format = mediaFormatFromPath(path);
  return format ? mediaFamilyFromFormat(format) : "image";
}

function MediaLoadingState() {
  return (
    <div
      className="flex min-h-0 flex-1 flex-col items-center justify-center gap-5 px-8 py-12"
      aria-label={m.media_loading()}
    >
      <div className="flex w-full max-w-md flex-col gap-4">
        <Skeleton className="mx-auto size-12 rounded-xl" />
        <Skeleton className="mx-auto h-5 w-48" />
        <Progress value={15} aria-label={m.media_loading_progress()} />
      </div>
    </div>
  );
}

function MediaFailureState({
  failure,
  externalOpen,
  onRetry,
}: {
  failure: MediaFailure;
  externalOpen: ExternalOpenBinding;
  onRetry(): void;
}) {
  const externalOnly =
    failure.kind === "external_only" ||
    failure.kind === "unsupported_codec" ||
    failure.kind === "unusable_range";
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

function failureTitle(failure: MediaFailure) {
  switch (failure.kind) {
    case "external_only":
      return m.media_external_only_title();
    case "malformed":
      return m.media_malformed_title();
    case "unsupported_codec":
      return m.media_unsupported_codec_title();
    case "unusable_range":
      return m.media_unusable_range_title();
    case "playback_error":
      return m.media_playback_error_title();
    case "resource_limit":
      return m.media_resource_limit_title();
    case "source_changed":
      return m.media_source_changed_title();
    case "source_missing":
      return m.media_source_missing_title();
    case "source_unavailable":
      return m.media_source_unavailable_title();
    case "runtime_error":
      return m.media_runtime_error_title();
  }
}

function failureDescription(failure: MediaFailure) {
  switch (failure.kind) {
    case "external_only":
      return m.media_external_only_description();
    case "malformed":
      return m.media_malformed_description();
    case "unsupported_codec":
      return m.media_unsupported_codec_description();
    case "unusable_range":
      return m.media_unusable_range_description();
    case "playback_error":
      return m.media_playback_error_description();
    case "resource_limit":
      return m.media_resource_limit_description();
    case "source_changed":
      return m.media_source_changed_description();
    case "source_missing":
      return m.media_source_missing_description();
    case "source_unavailable":
      return m.media_source_unavailable_description();
    case "runtime_error":
      return m.media_runtime_error_description();
  }
}
