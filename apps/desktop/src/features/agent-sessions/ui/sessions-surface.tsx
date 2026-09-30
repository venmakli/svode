import type { ComponentProps } from "react";
import { AlertTriangle, Info, RefreshCw } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  CollectionHost,
  CollectionToolbarActionButton,
} from "@/features/collection";
import type { RoutineLaunchLink } from "@/features/routines/catalog";
import type { ScopeSurfaceRenderContext } from "@/features/scope-surfaces";
import { useAgentSessionsCollection } from "../hooks/use-agent-sessions-collection";
import type { AgentSessionOpenOptions, AgentSessionTarget } from "../model";
import { ExternalTerminalAppProvider } from "./external-terminal-icon";
import { SessionsDiagnosticsDialog } from "./sessions-diagnostics-dialog";
import * as m from "@/paraglide/messages.js";

/** The "Sessions" tab of a registered Space: its own sessions of this device. */
export function AgentSessionsSurface({
  owner,
  onOpenSession,
  onOpenAppSettings,
  onOpenRoutine,
}: ScopeSurfaceRenderContext & {
  onOpenSession(
    target: AgentSessionTarget,
    options?: AgentSessionOpenOptions,
  ): void;
  onOpenAppSettings(): void;
  onOpenRoutine(routine: RoutineLaunchLink): void;
}) {
  const controller = useAgentSessionsCollection({
    owner,
    onOpenSession,
    onOpenAppSettings,
    onOpenRoutine,
  });

  return (
    <ExternalTerminalAppProvider>
      <div className="flex min-h-0 flex-1 flex-col" data-sessions-surface>
        {controller.collectionState.phase === "ready" ? (
          <CollectionHost
            contextualActions={
              <>
                <SessionsDiagnosticsDialog
                  problem={controller.sourceProblem}
                  retrying={controller.refreshing}
                  onRetry={() => void controller.refresh()}
                  onOpenSettings={controller.openAppSettings}
                />
                <ToolbarTooltipButton
                  icon={Info}
                  label={m.sessions_device_note()}
                />
                <ToolbarTooltipButton
                  icon={RefreshCw}
                  label={m.sessions_action_refresh()}
                  disabled={controller.refreshing}
                  onClick={() => void controller.refresh()}
                />
              </>
            }
            instance={controller.instance}
            state={controller.collectionState}
          />
        ) : (
          <div className="px-6 py-3">
            <Alert variant="destructive">
              <AlertTriangle />
              <AlertDescription>
                {controller.collectionState.diagnostics.join(" ")}
              </AlertDescription>
            </Alert>
          </div>
        )}
      </div>
      <AlertDialog
        open={controller.closeRequest !== null}
        onOpenChange={(open) => {
          if (!open) controller.dismissClose();
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {m.sessions_close_terminal_confirm_title()}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {m.sessions_close_terminal_confirm_description()}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{m.project_cancel()}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={controller.confirmClose}
            >
              {m.sessions_action_close_terminal()}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </ExternalTerminalAppProvider>
  );
}

function ToolbarTooltipButton({
  label,
  ...props
}: ComponentProps<typeof CollectionToolbarActionButton>) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <CollectionToolbarActionButton label={label} {...props} />
      </TooltipTrigger>
      <TooltipContent className="max-w-72">{label}</TooltipContent>
    </Tooltip>
  );
}
