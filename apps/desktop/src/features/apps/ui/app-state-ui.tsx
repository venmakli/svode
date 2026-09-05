import {
  AppWindow,
  FileWarning,
  FolderOpen,
  KeyRound,
  RefreshCw,
  RotateCcw,
  ScrollText,
  Square,
  Wrench,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  Popover,
  PopoverContent,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { AppProcessLogs, AppProcessPhase } from "../model/types";
import * as m from "@/paraglide/messages.js";

export function AppLoadingState() {
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

export function AppProcessState({
  title,
  description,
  logs,
  onStop,
}: {
  title: string;
  description: string;
  logs: AppProcessLogs;
  onStop(): void;
}) {
  return (
    <Empty className="h-full min-h-[20rem] border-0">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <AppWindow />
        </EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
      <EmptyContent className="max-w-2xl">
        <Button variant="destructive" onClick={onStop}>
          <Square data-icon="inline-start" />
          {m.app_stop()}
        </Button>
        <AppLogsDisclosure logs={logs} />
      </EmptyContent>
    </Empty>
  );
}

export function AppRecovery({
  title,
  description,
  logs,
  onRetry,
  onRestart,
  onRerunSetup,
  onShowFiles,
  onOpenBrowser,
  onVariables,
}: {
  title: string;
  description: string;
  logs?: AppProcessLogs;
  onRetry?: () => void;
  onRestart?: () => void;
  onRerunSetup?: () => void;
  onShowFiles(): void;
  onOpenBrowser?: () => void;
  onVariables?: () => void;
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
      <EmptyContent className="max-w-2xl">
        <div className="flex flex-wrap justify-center gap-2">
          {onRetry ? (
            <Button onClick={onRetry}>
              <RefreshCw data-icon="inline-start" />
              {m.app_retry()}
            </Button>
          ) : null}
          {onVariables ? (
            <Button
              variant={onRetry ? "outline" : "default"}
              onClick={onVariables}
            >
              <KeyRound data-icon="inline-start" />
              {m.app_variables()}
            </Button>
          ) : null}
          {onRestart ? (
            <Button variant="outline" onClick={onRestart}>
              <RotateCcw data-icon="inline-start" />
              {m.app_restart()}
            </Button>
          ) : null}
          {onRerunSetup ? (
            <Button variant="outline" onClick={onRerunSetup}>
              <Wrench data-icon="inline-start" />
              {m.app_rerun_setup()}
            </Button>
          ) : null}
          <Button variant="outline" onClick={onShowFiles}>
            <FolderOpen data-icon="inline-start" />
            {m.app_show_files()}
          </Button>
          {onOpenBrowser ? (
            <Button variant="outline" onClick={onOpenBrowser}>
              <AppWindow data-icon="inline-start" />
              {m.app_open_browser()}
            </Button>
          ) : null}
        </div>
        {logs ? <AppLogsDisclosure logs={logs} /> : null}
      </EmptyContent>
    </Empty>
  );
}

export function AppLogsPopover({
  logs,
  canRerunSetup,
  onRerunSetup,
}: {
  logs: AppProcessLogs;
  canRerunSetup: boolean;
  onRerunSetup(): void;
}) {
  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button
              size="icon-sm"
              variant="secondary"
              aria-label={m.app_logs()}
            >
              <ScrollText />
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom">{m.app_logs()}</TooltipContent>
      </Tooltip>
      <PopoverContent align="end" className="w-[min(32rem,calc(100vw-2rem))]">
        <PopoverHeader>
          <PopoverTitle>{m.app_logs()}</PopoverTitle>
        </PopoverHeader>
        <AppLogOutput logs={logs} />
        {canRerunSetup ? (
          <Button size="sm" variant="outline" onClick={onRerunSetup}>
            <Wrench data-icon="inline-start" />
            {m.app_rerun_setup()}
          </Button>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

function AppLogsDisclosure({ logs }: { logs: AppProcessLogs }) {
  return (
    <Collapsible className="w-full text-left">
      <CollapsibleTrigger asChild>
        <Button size="sm" variant="ghost">
          <ScrollText data-icon="inline-start" />
          {m.app_logs()}
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="pt-2">
        <AppLogOutput logs={logs} />
      </CollapsibleContent>
    </Collapsible>
  );
}

function AppLogOutput({ logs }: { logs: AppProcessLogs }) {
  if (!logs.stdout && !logs.stderr) {
    return <p className="text-sm text-muted-foreground">{m.app_no_logs()}</p>;
  }
  return (
    <ScrollArea className="h-48 w-full rounded-md border bg-muted/30">
      <div className="flex min-w-0 flex-col gap-3 p-3 text-left">
        {logs.stdout ? (
          <AppLogStream label={m.app_stdout()} value={logs.stdout} />
        ) : null}
        {logs.stderr ? (
          <AppLogStream label={m.app_stderr()} value={logs.stderr} />
        ) : null}
      </div>
    </ScrollArea>
  );
}

function AppLogStream({ label, value }: { label: string; value: string }) {
  return (
    <section className="min-w-0" aria-label={label}>
      <p className="mb-1 text-xs font-medium text-muted-foreground">{label}</p>
      <pre className="whitespace-pre-wrap break-words font-mono text-xs">
        {value}
      </pre>
    </section>
  );
}

export function processPhaseCopy(phase: AppProcessPhase) {
  switch (phase) {
    case "setup":
      return {
        title: m.app_process_setup_title(),
        description: m.app_process_setup_description(),
      };
    case "starting":
      return {
        title: m.app_process_starting_title(),
        description: m.app_process_starting_description(),
      };
    case "waiting_for_url":
      return {
        title: m.app_process_waiting_title(),
        description: m.app_process_waiting_description(),
      };
  }
}

export function processFailureCopy(reason: string) {
  if (reason === "process_stopped") {
    return {
      title: m.app_process_stopped_title(),
      description: m.app_process_stopped_description(),
    };
  }
  if (reason === "missing_app_variables") {
    return {
      title: m.app_variables_missing_title(),
      description: m.app_variables_missing_default_description(),
    };
  }
  if (reason.startsWith("setup_")) {
    return {
      title: m.app_process_setup_failed_title(),
      description: m.app_process_setup_failed_description(),
    };
  }
  if (reason === "url_readiness_timeout") {
    return {
      title: m.app_process_waiting_failed_title(),
      description: m.app_process_waiting_failed_description(),
    };
  }
  if (reason === "process_exited") {
    return {
      title: m.app_process_exited_title(),
      description: m.app_process_exited_description(),
    };
  }
  return {
    title: m.app_process_start_failed_title(),
    description: m.app_process_start_failed_description(),
  };
}
