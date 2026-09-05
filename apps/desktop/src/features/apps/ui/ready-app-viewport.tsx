import { useState } from "react";
import {
  AppWindow,
  FolderOpen,
  RefreshCw,
  RotateCcw,
  Square,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import type { AppSession } from "../model/types";
import { AppLoadingState, AppLogsPopover, AppRecovery } from "./app-state-ui";
import * as m from "@/paraglide/messages.js";

export function ReadyAppViewport({
  session,
  onRestart,
  onStop,
  onRerunSetup,
  onShowFiles,
  onOpenBrowser,
}: {
  session: Extract<AppSession, { status: "ready" }>;
  onRestart(): void;
  onStop(): void;
  onRerunSetup(): void;
  onShowFiles(): void;
  onOpenBrowser(url: string): void;
}) {
  const [frameKey, setFrameKey] = useState(0);
  const [frameState, setFrameState] = useState<"loading" | "ready" | "error">(
    "loading",
  );
  const process =
    session.runtimeType === "process" ? session.process : undefined;

  if (frameState === "error") {
    return (
      <AppRecovery
        title={m.app_viewport_error_title()}
        description={m.app_viewport_error_description()}
        onRetry={() => {
          setFrameState("loading");
          setFrameKey((key) => key + 1);
        }}
        onRestart={process ? onRestart : undefined}
        onShowFiles={onShowFiles}
        onOpenBrowser={
          session.runtimeType !== "static"
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
        <div className="absolute right-3 top-3 flex gap-1 opacity-0 transition-opacity focus-within:opacity-100 hover:opacity-100">
          {process ? (
            <AppLogsPopover
              logs={process.logs}
              canRerunSetup={process.hasSetup}
              onRerunSetup={onRerunSetup}
            />
          ) : null}
          <Button
            size="icon-sm"
            variant="secondary"
            aria-label={m.app_show_files()}
            onClick={onShowFiles}
          >
            <FolderOpen />
          </Button>
          {session.runtimeType !== "static" ? (
            <Button
              size="icon-sm"
              variant="secondary"
              aria-label={m.app_open_browser()}
              onClick={() => onOpenBrowser(session.viewportUrl)}
            >
              <AppWindow />
            </Button>
          ) : null}
          {process ? (
            <Button
              size="icon-sm"
              variant="secondary"
              aria-label={m.app_restart()}
              onClick={onRestart}
            >
              <RotateCcw />
            </Button>
          ) : null}
          {process?.managed ? (
            <Button
              size="icon-sm"
              variant="destructive"
              aria-label={m.app_stop()}
              onClick={onStop}
            >
              <Square />
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
