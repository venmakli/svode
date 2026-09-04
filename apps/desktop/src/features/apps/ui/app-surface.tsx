import { useState } from "react";
import { AppWindow, FileWarning, FolderOpen, RefreshCw } from "lucide-react";
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
import { openAppOwnerDirectory, openAppUrlInBrowser } from "../api/app-api";
import { useAppSession } from "../hooks/use-app-session";
import type { AppOwner, AppSession } from "../model/types";
import * as m from "@/paraglide/messages.js";

export function AppSurface({ owner }: { owner: AppOwner }) {
  const { retry, session } = useAppSession(owner);

  return (
    <AppViewport
      session={session}
      onRetry={retry}
      onShowFiles={() => void openAppOwnerDirectory(owner)}
      onOpenBrowser={(url) => void openAppUrlInBrowser(url)}
    />
  );
}

export function AppViewport({
  session,
  onRetry,
  onShowFiles,
  onOpenBrowser,
}: {
  session: AppSession;
  onRetry(): void;
  onShowFiles(): void;
  onOpenBrowser(url: string): void;
}) {
  if (session.status === "loading") return <AppLoadingState />;
  if (session.status === "error") {
    return (
      <AppRecovery
        title={m.app_load_error_title()}
        description={m.app_load_error_description()}
        onRetry={onRetry}
        onShowFiles={onShowFiles}
      />
    );
  }
  if (session.status === "missing") {
    return (
      <AppRecovery
        title={m.app_missing_title()}
        description={m.app_missing_description()}
        onRetry={onRetry}
        onShowFiles={onShowFiles}
      />
    );
  }
  if (session.status === "invalid") {
    const diagnostic = session.diagnostics[0];
    return (
      <AppRecovery
        title={m.app_invalid_title()}
        description={
          diagnostic
            ? `${diagnostic.path}: ${diagnostic.message}`
            : m.app_invalid_description()
        }
        onRetry={onRetry}
        onShowFiles={onShowFiles}
      />
    );
  }
  if (session.status === "unavailable") {
    const isProcessPending = session.reason === "process_runtime_pending";
    return (
      <AppRecovery
        title={
          isProcessPending
            ? m.app_process_pending_title()
            : m.app_unavailable_title()
        }
        description={
          isProcessPending
            ? m.app_process_pending_description()
            : m.app_unavailable_description()
        }
        onRetry={onRetry}
        onShowFiles={onShowFiles}
        onOpenBrowser={
          session.browserUrl
            ? () => onOpenBrowser(session.browserUrl!)
            : undefined
        }
      />
    );
  }

  return (
    <ReadyAppViewport
      key={session.viewportUrl}
      session={session}
      onShowFiles={onShowFiles}
      onOpenBrowser={onOpenBrowser}
    />
  );
}

function ReadyAppViewport({
  session,
  onShowFiles,
  onOpenBrowser,
}: {
  session: Extract<AppSession, { status: "ready" }>;
  onShowFiles(): void;
  onOpenBrowser(url: string): void;
}) {
  const [frameKey, setFrameKey] = useState(0);
  const [frameState, setFrameState] = useState<"loading" | "ready" | "error">(
    "loading",
  );

  if (frameState === "error") {
    return (
      <AppRecovery
        title={m.app_viewport_error_title()}
        description={m.app_viewport_error_description()}
        onRetry={() => {
          setFrameState("loading");
          setFrameKey((key) => key + 1);
        }}
        onShowFiles={onShowFiles}
        onOpenBrowser={
          session.runtimeType === "url"
            ? () => onOpenBrowser(session.viewportUrl)
            : undefined
        }
      />
    );
  }

  return (
    <div className="relative h-full min-h-[20rem] w-full overflow-hidden bg-background">
      <iframe
        key={`${session.viewportUrl}:${frameKey}`}
        className="h-full w-full border-0 bg-background"
        src={session.viewportUrl}
        title={m.app_viewport_title()}
        sandbox="allow-downloads allow-forms allow-modals allow-popups allow-same-origin allow-scripts"
        referrerPolicy="no-referrer"
        onLoad={() => setFrameState("ready")}
        onError={() => setFrameState("error")}
      />
      {frameState === "loading" ? (
        <div className="absolute inset-0 bg-background">
          <AppLoadingState />
        </div>
      ) : null}
      {frameState === "ready" ? (
        <div className="pointer-events-none absolute right-3 top-3 flex gap-1 opacity-0 transition-opacity focus-within:pointer-events-auto focus-within:opacity-100 hover:pointer-events-auto hover:opacity-100">
          <Button
            size="icon-sm"
            variant="secondary"
            aria-label={m.app_show_files()}
            onClick={onShowFiles}
          >
            <FolderOpen />
          </Button>
          {session.runtimeType === "url" ? (
            <Button
              size="icon-sm"
              variant="secondary"
              aria-label={m.app_open_browser()}
              onClick={() => onOpenBrowser(session.viewportUrl)}
            >
              <AppWindow />
            </Button>
          ) : null}
          <Button
            size="icon-sm"
            variant="secondary"
            aria-label={m.app_reload()}
            onClick={() => {
              setFrameState("loading");
              setFrameKey((key) => key + 1);
            }}
          >
            <RefreshCw />
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function AppLoadingState() {
  return (
    <div
      className="flex h-full min-h-[20rem] flex-col gap-4 p-6"
      aria-label={m.app_loading()}
    >
      <Skeleton className="h-7 w-1/3" />
      <Skeleton className="h-4 w-1/2" />
      <Skeleton className="min-h-52 flex-1 w-full" />
    </div>
  );
}

function AppRecovery({
  title,
  description,
  onRetry,
  onShowFiles,
  onOpenBrowser,
}: {
  title: string;
  description: string;
  onRetry(): void;
  onShowFiles(): void;
  onOpenBrowser?: () => void;
}) {
  return (
    <Empty className="h-full min-h-[20rem] border-0">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <FileWarning />
        </EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
      <EmptyContent className="flex-row flex-wrap justify-center">
        <Button onClick={onRetry}>
          <RefreshCw />
          {m.app_retry()}
        </Button>
        <Button variant="outline" onClick={onShowFiles}>
          <FolderOpen />
          {m.app_show_files()}
        </Button>
        {onOpenBrowser ? (
          <Button variant="outline" onClick={onOpenBrowser}>
            <AppWindow />
            {m.app_open_browser()}
          </Button>
        ) : null}
      </EmptyContent>
    </Empty>
  );
}
