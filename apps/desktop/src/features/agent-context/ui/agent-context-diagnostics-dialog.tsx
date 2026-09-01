import { AlertTriangle } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { CollectionToolbarActionButton } from "@/features/collection";
import * as m from "@/paraglide/messages.js";

import {
  countAgentContextDiagnostics,
  type AgentContextDiagnosticGroup,
  type AgentContextDiagnosticGroupId,
  type AgentContextDiagnosticRecord,
} from "../model/diagnostics";

export function AgentContextDiagnosticsDialog({
  groups,
  onRetry,
  retrying,
}: {
  groups: readonly AgentContextDiagnosticGroup[];
  onRetry(): void;
  retrying: boolean;
}) {
  const count = countAgentContextDiagnostics(groups);
  if (count === 0) return null;

  const hasRefreshFailure = groups.some((group) =>
    group.diagnostics.some((diagnostic) => diagnostic.origin === "runtime"),
  );

  return (
    <Dialog>
      <DialogTrigger asChild>
        <CollectionToolbarActionButton
          count={count}
          icon={AlertTriangle}
          label={m.agent_context_diagnostics_trigger({ count })}
        />
      </DialogTrigger>
      <DialogContent
        className="flex max-h-[min(85vh,44rem)] flex-col sm:max-w-2xl"
        data-agent-context-diagnostics-dialog
      >
        <DialogHeader>
          <DialogTitle>{m.agent_context_diagnostics_title()}</DialogTitle>
          <DialogDescription>
            {m.agent_context_diagnostics_description({ count })}
          </DialogDescription>
        </DialogHeader>
        <ScrollArea className="h-[min(55vh,30rem)] min-h-0">
          <AgentContextDiagnosticList groups={groups} />
        </ScrollArea>
        {hasRefreshFailure ? (
          <DialogFooter>
            <Button
              type="button"
              disabled={retrying}
              variant="outline"
              onClick={onRetry}
            >
              {m.agent_context_retry()}
            </Button>
          </DialogFooter>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

export function AgentContextDiagnosticList({
  groups,
}: {
  groups: readonly AgentContextDiagnosticGroup[];
}) {
  return (
    <div className="flex flex-col gap-5 pr-4">
      {groups.map((group) => (
        <section
          key={group.id}
          className="flex flex-col gap-2"
          data-agent-context-diagnostic-group={group.id}
        >
          <h3 className="text-sm font-medium">
            {diagnosticGroupLabel(group.id)}
          </h3>
          <div className="flex flex-col">
            {group.diagnostics.map((diagnostic, index) => (
              <div key={diagnosticIdentity(diagnostic)}>
                {index > 0 ? <Separator /> : null}
                <DiagnosticRecord diagnostic={diagnostic} />
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function DiagnosticRecord({
  diagnostic,
}: {
  diagnostic: AgentContextDiagnosticRecord;
}) {
  return (
    <article
      className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0"
      data-agent-context-diagnostic={diagnostic.code}
    >
      <p className="select-text whitespace-pre-wrap break-words">
        {diagnostic.message}
      </p>
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge variant="outline">{diagnostic.code}</Badge>
        <Badge
          variant={
            diagnostic.severity === "error" ? "destructive" : "secondary"
          }
        >
          {diagnosticSeverityLabel(diagnostic.severity)}
        </Badge>
        {diagnostic.adapterId ? (
          <Badge variant="outline">{diagnostic.adapterId}</Badge>
        ) : null}
      </div>
      {diagnostic.path ? (
        <dl className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-2 text-xs text-muted-foreground">
          <dt>{m.agent_context_diagnostic_path()}</dt>
          <dd className="select-text break-all">{diagnostic.path}</dd>
        </dl>
      ) : null}
    </article>
  );
}

function diagnosticGroupLabel(group: AgentContextDiagnosticGroupId): string {
  switch (group) {
    case "clients":
      return m.agent_context_diagnostics_group_clients();
    case "instructions":
      return m.agent_context_diagnostics_group_instructions();
    case "skills":
      return m.agent_context_diagnostics_group_skills();
    case "runtime":
      return m.agent_context_diagnostics_group_runtime();
    case "other":
      return m.agent_context_diagnostics_group_other();
  }
}

function diagnosticSeverityLabel(
  severity: AgentContextDiagnosticRecord["severity"],
): string {
  return severity === "error"
    ? m.agent_context_diagnostic_severity_error()
    : m.agent_context_diagnostic_severity_warning();
}

function diagnosticIdentity(diagnostic: AgentContextDiagnosticRecord): string {
  return JSON.stringify([
    diagnostic.code,
    diagnostic.severity,
    diagnostic.message,
    diagnostic.path,
    diagnostic.adapterId,
  ]);
}
