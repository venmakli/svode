import { openAppOwnerDirectory, openAppUrlInBrowser } from "../api/app-api";
import { useAppSession } from "../hooks/use-app-session";
import type { AppOwner, AppSession } from "../model/types";
import {
  AppLoadingState,
  AppProcessState,
  AppRecovery,
  processFailureCopy,
  processPhaseCopy,
} from "./app-state-ui";
import { ReadyAppViewport } from "./ready-app-viewport";
import * as m from "@/paraglide/messages.js";

export function AppSurface({ owner }: { owner: AppOwner }) {
  const { rerunSetup, restart, retry, session, stop } = useAppSession(owner);

  return (
    <AppViewport
      session={session}
      onRetry={retry}
      onRestart={restart}
      onStop={stop}
      onRerunSetup={rerunSetup}
      onShowFiles={() => void openAppOwnerDirectory(owner)}
      onOpenBrowser={(url) => void openAppUrlInBrowser(url)}
    />
  );
}

export function AppViewport({
  session,
  onRetry,
  onRestart,
  onStop,
  onRerunSetup,
  onShowFiles,
  onOpenBrowser,
}: {
  session: AppSession;
  onRetry(): void;
  onRestart(): void;
  onStop(): void;
  onRerunSetup(): void;
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
  if (session.status === "launching") {
    const copy = processPhaseCopy(session.phase);
    return (
      <AppProcessState
        title={copy.title}
        description={copy.description}
        logs={session.process.logs}
        onStop={onStop}
      />
    );
  }
  if (session.status === "unavailable") {
    const browserUrl = session.browserUrl;
    const processCopy =
      session.runtimeType === "process"
        ? processFailureCopy(session.reason)
        : undefined;
    const canRetry = session.reason !== "process_environment_pending";
    return (
      <AppRecovery
        title={processCopy?.title ?? m.app_unavailable_title()}
        description={
          processCopy?.description ?? m.app_unavailable_description()
        }
        logs={session.process?.logs}
        onRetry={canRetry ? onRetry : undefined}
        onRerunSetup={
          canRetry && session.process?.hasSetup ? onRerunSetup : undefined
        }
        onShowFiles={onShowFiles}
        onOpenBrowser={browserUrl ? () => onOpenBrowser(browserUrl) : undefined}
      />
    );
  }

  return (
    <ReadyAppViewport
      key={session.viewportUrl}
      session={session}
      onRestart={onRestart}
      onStop={onStop}
      onRerunSetup={onRerunSetup}
      onShowFiles={onShowFiles}
      onOpenBrowser={onOpenBrowser}
    />
  );
}
