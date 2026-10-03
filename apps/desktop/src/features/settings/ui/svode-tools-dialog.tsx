import { useId, useState } from "react";
import { Check, LoaderCircle, TriangleAlert, X } from "lucide-react";
import * as m from "@/paraglide/messages.js";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldSeparator,
} from "@/components/ui/field";
import type { McpStatus } from "../hooks/use-mcp-integrations";
import {
  initialToolsChoice,
  sharedChoice,
  skillOnlyReaders,
  toolsEntries,
  toolsPlan,
  type IntegrationKit,
  type IntegrationOperation,
  type ToolsChange,
  type ToolsChoice,
  type ToolsEntry,
} from "../model/svode-integration";
import { externalText, problemText } from "./svode-integration-group";

function kitText(kit: IntegrationKit) {
  switch (kit) {
    case "plugin":
      return m.settings_tools_kit_plugin();
    case "mcp_shared":
      return m.settings_tools_kit_mcp_shared();
    case "mcp":
      return m.settings_tools_kit_mcp();
  }
}

function entryState(entry: ToolsEntry) {
  const blocked = entry.blocked;
  if (blocked?.reason === "unsupported")
    return m.settings_agents_state_deferred();
  if (blocked?.reason === "external") return externalText(blocked.source);
  if (blocked?.reason === "conflict")
    return problemText(blocked.code, blocked.configPath);
  if (blocked?.reason === "policy")
    return problemText("client_policy_blocked", null);
  if (blocked?.reason === "runtime")
    return m.settings_providers_runtime_unavailable_title();
  return entry.installed ? m.settings_tools_state_installed() : null;
}

type Result = { operation: IntegrationOperation; error: string | null };

/**
 * The found agents Svode can give its tools, with the shared skill, a
 * summary before applying and a result per change after it. The list is
 * temporary: the page keeps one list of agents.
 */
export function SvodeToolsDialog({
  status,
  foundAgents,
  label,
  run,
  onClose,
}: {
  status: McpStatus;
  foundAgents: string[];
  label: (agent: string) => string;
  run: (operation: IntegrationOperation) => Promise<string | null>;
  onClose: () => void;
}) {
  const idPrefix = useId();
  const entries = toolsEntries(status, foundAgents);
  const [choice, setChoice] = useState<ToolsChoice>(() =>
    initialToolsChoice(status, entries),
  );
  // The plan as it was applied: its lines name the results.
  const [applied, setApplied] = useState<{
    changes: ToolsChange[];
    results: (Result | null)[];
  } | null>(null);
  const [running, setRunning] = useState(false);
  const shared = sharedChoice(status, entries, choice);
  const skillOnly = skillOnlyReaders(status);
  const plan = toolsPlan(status, entries, choice);
  const names = (agents: string[]) => agents.map(label).join(", ");

  const changeText = (change: ToolsChange) => {
    switch (change.kind) {
      case "install":
        return change.kit === "plugin"
          ? m.settings_tools_change_install_plugin({
              agent: label(change.agent),
            })
          : m.settings_tools_change_install_mcp({ agent: label(change.agent) });
      case "remove":
        return change.kit === "plugin"
          ? m.settings_tools_change_remove_plugin({
              agent: label(change.agent),
            })
          : m.settings_tools_change_remove_mcp({ agent: label(change.agent) });
      case "add_shared":
        return m.settings_tools_change_add_shared({
          agents: names(change.readers),
        });
      case "remove_shared":
        return change.readers.length
          ? m.settings_tools_change_remove_shared({
              agents: names(change.readers),
            })
          : m.settings_tools_change_remove_shared_alone();
    }
  };

  // Runs the operations in order; each line of the plan gets its result.
  const execute = async (
    changes: ToolsChange[],
    operations: IntegrationOperation[],
    previous: (Result | null)[] | null,
  ) => {
    setRunning(true);
    const results = changes.map((_, index) => previous?.[index] ?? null);
    setApplied({ changes, results: [...results] });
    for (const operation of operations) {
      const index = changes.findIndex((change) => matches(change, operation));
      const error = await run(operation);
      results[index] = { operation, error };
      setApplied({ changes, results: [...results] });
    }
    setRunning(false);
  };

  const apply = () => void execute(plan.changes, plan.operations, null);

  const retry = () => {
    if (!applied) return;
    const failed = applied.results.flatMap((result) =>
      result?.error ? [result.operation] : [],
    );
    void execute(
      applied.changes,
      failed,
      applied.results.map((result) => (result?.error ? null : result)),
    );
  };

  const failedCount =
    applied?.results.filter((result) => result?.error).length ?? 0;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !running) onClose();
      }}
    >
      <DialogContent
        data-svode-tools
        className="flex max-h-[calc(100dvh-2rem)] min-w-0 flex-col overflow-hidden sm:max-w-md"
      >
        <DialogHeader className="min-w-0 shrink-0">
          <DialogTitle>{m.settings_tools_title()}</DialogTitle>
          <DialogDescription className="wrap-anywhere">
            {m.settings_tools_description()}
          </DialogDescription>
        </DialogHeader>

        <div className="flex min-h-0 min-w-0 flex-col gap-4 overflow-y-auto">
          {applied ? (
            <ul className="flex min-w-0 flex-col gap-2" data-tools-results>
              {applied.changes.map((change, index) => {
                const result = applied.results[index];
                // A shared skill that comes with an agent has no operation of
                // its own: the result of that agent is its result.
                const linked = change.kind === "add_shared";
                return (
                  <li
                    key={`${change.kind}:${"agent" in change ? change.agent : ""}`}
                    data-tools-result={
                      linked
                        ? undefined
                        : result
                          ? result.error
                            ? "failed"
                            : "done"
                          : "pending"
                    }
                    className="flex min-w-0 items-start gap-2 text-sm"
                  >
                    {linked ? (
                      <span className="size-4 shrink-0" />
                    ) : result ? (
                      result.error ? (
                        <X className="mt-0.5 size-4 shrink-0 text-destructive" />
                      ) : (
                        <Check className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                      )
                    ) : (
                      <LoaderCircle className="mt-0.5 size-4 shrink-0 animate-spin text-muted-foreground" />
                    )}
                    <span className="min-w-0 wrap-anywhere">
                      {changeText(change)}
                      {result ? (
                        <span
                          className={
                            result.error
                              ? "block text-destructive"
                              : "block text-muted-foreground"
                          }
                        >
                          {result.error
                            ? m.settings_tools_result_failed({
                                reason: result.error,
                              })
                            : m.settings_tools_result_done()}
                        </span>
                      ) : null}
                    </span>
                  </li>
                );
              })}
            </ul>
          ) : (
            <>
              <Alert className="min-w-0 max-w-full">
                <TriangleAlert data-icon="inline-start" />
                <AlertDescription className="min-w-0 max-w-full break-words [overflow-wrap:anywhere]">
                  {m.settings_tools_pii()}
                </AlertDescription>
              </Alert>
              <FieldGroup className="gap-3">
                {entries.map((entry) => {
                  const id = `${idPrefix}-${entry.agent}`;
                  const state = entryState(entry);
                  const details = [
                    entry.kit ? kitText(entry.kit) : null,
                    state,
                  ].filter(Boolean);
                  return (
                    <Field
                      key={entry.agent}
                      orientation="horizontal"
                      data-tools-agent={entry.agent}
                      data-disabled={entry.blocked ? true : undefined}
                    >
                      <Checkbox
                        id={id}
                        checked={Boolean(choice.agents[entry.agent])}
                        disabled={entry.blocked !== null}
                        onCheckedChange={(checked) =>
                          setChoice((current) => ({
                            ...current,
                            agents: {
                              ...current.agents,
                              [entry.agent]: checked === true,
                            },
                          }))
                        }
                      />
                      <FieldContent>
                        <FieldLabel htmlFor={id}>
                          {label(entry.agent)}
                        </FieldLabel>
                        <FieldDescription>
                          {details.join(" · ")}
                        </FieldDescription>
                      </FieldContent>
                    </Field>
                  );
                })}
                {shared ? (
                  <>
                    <FieldSeparator />
                    <Field
                      orientation="horizontal"
                      data-tools-shared
                      data-disabled={shared.locked ? true : undefined}
                    >
                      <Checkbox
                        id={`${idPrefix}-shared`}
                        checked={shared.checked}
                        disabled={shared.locked}
                        onCheckedChange={(checked) =>
                          setChoice((current) => ({
                            ...current,
                            shared: checked === true,
                          }))
                        }
                      />
                      <FieldContent>
                        <FieldLabel htmlFor={`${idPrefix}-shared`}>
                          {m.settings_integration_part_shared()}
                        </FieldLabel>
                        <FieldDescription>
                          {[
                            status.sharedSkill.readers.length
                              ? m.settings_integration_readers({
                                  agents: names(status.sharedSkill.readers),
                                })
                              : m.settings_integration_no_readers(),
                            skillOnly.length
                              ? m.settings_integration_skill_only({
                                  agents: names(skillOnly),
                                })
                              : null,
                            shared.neededBy.length
                              ? m.settings_tools_shared_needed({
                                  agents: names(shared.neededBy),
                                })
                              : shared.installed
                                ? null
                                : m.settings_tools_shared_with_agents(),
                          ]
                            .filter(Boolean)
                            .join(" · ")}
                        </FieldDescription>
                      </FieldContent>
                    </Field>
                  </>
                ) : null}
              </FieldGroup>
              <section
                aria-label={m.settings_tools_changes()}
                data-tools-summary
                className="flex min-w-0 flex-col gap-1 rounded-md bg-muted/40 p-3 text-sm"
              >
                <h3 className="font-medium">{m.settings_tools_changes()}</h3>
                {plan.changes.length ? (
                  <ul className="flex min-w-0 list-disc flex-col gap-1 pl-4">
                    {plan.changes.map((change) => (
                      <li
                        key={`${change.kind}:${"agent" in change ? change.agent : ""}`}
                        className="wrap-anywhere"
                      >
                        {changeText(change)}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-muted-foreground">
                    {m.settings_tools_no_changes()}
                  </p>
                )}
              </section>
            </>
          )}
        </div>

        <DialogFooter className="shrink-0">
          {applied ? (
            <>
              {failedCount && !running ? (
                <Button variant="outline" onClick={retry}>
                  {m.settings_tools_retry()}
                </Button>
              ) : null}
              <Button disabled={running} onClick={onClose}>
                {running ? (
                  <LoaderCircle
                    data-icon="inline-start"
                    className="animate-spin"
                  />
                ) : null}
                {running
                  ? m.settings_tools_applying()
                  : m.settings_tools_close()}
              </Button>
            </>
          ) : (
            <>
              <Button variant="outline" onClick={onClose}>
                {m.project_cancel()}
              </Button>
              <Button disabled={!plan.operations.length} onClick={apply}>
                {m.settings_tools_apply()}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function matches(change: ToolsChange, operation: IntegrationOperation) {
  if (operation.kind === "remove_shared")
    return change.kind === "remove_shared";
  return change.kind === operation.kind && change.agent === operation.client;
}
