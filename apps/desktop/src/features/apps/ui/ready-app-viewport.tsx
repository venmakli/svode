import { useState } from "react";
import {
  AppWindow,
  FolderOpen,
  KeyRound,
  RefreshCw,
  RotateCcw,
  Square,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
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
  onVariables,
}: {
  session: Extract<AppSession, { status: "ready" }>;
  onRestart(): void;
  onStop(): void;
  onRerunSetup(): void;
  onShowFiles(): void;
  onOpenBrowser(url: string): void;
  onVariables?(): void;
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
          {process && onVariables ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  size="icon-sm"
                  variant="secondary"
                  aria-label={m.app_variables()}
                  onClick={onVariables}
                >
                  <KeyRound />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">{m.app_variables()}</TooltipContent>
            </Tooltip>
          ) : null}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="icon-sm"
                variant="secondary"
                aria-label={m.app_show_files()}
                onClick={onShowFiles}
              >
                <FolderOpen />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{m.app_show_files()}</TooltipContent>
          </Tooltip>
          {session.runtimeType !== "static" ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  size="icon-sm"
                  variant="secondary"
                  aria-label={m.app_open_browser()}
                  onClick={() => onOpenBrowser(session.viewportUrl)}
                >
                  <AppWindow />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                {m.app_open_browser()}
              </TooltipContent>
            </Tooltip>
          ) : null}
          <Tooltip>
            <TooltipTrigger asChild>
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
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {m.app_reload_tooltip()}
            </TooltipContent>
          </Tooltip>
          {process?.managed ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  size="icon-sm"
                  variant="destructive"
                  aria-label={m.app_stop()}
                  onClick={onStop}
                >
                  <Square />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                {m.app_stop_tooltip()}
              </TooltipContent>
            </Tooltip>
          ) : null}
          {process ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  size="icon-sm"
                  variant={process.managed ? "destructive" : "secondary"}
                  aria-label={m.app_restart()}
                  onClick={onRestart}
                >
                  <RotateCcw />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                {process.managed
                  ? m.app_restart_tooltip()
                  : m.app_restart_external_tooltip()}
              </TooltipContent>
            </Tooltip>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
