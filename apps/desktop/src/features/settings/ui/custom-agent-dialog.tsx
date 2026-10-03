import { useState, type FormEvent } from "react";
import { LoaderCircle, TriangleAlert } from "lucide-react";
import * as m from "@/paraglide/messages.js";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
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
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type {
  AgentCheckDto,
  CustomAgentDefinitionDto,
  CustomAgentSetupDto,
} from "../api";
import {
  agentOperationError,
  checkedState,
  type AgentOperationError,
  type AgentRowState,
} from "../model/agent-row";
import {
  customAgentDefinition,
  customAgentDraft,
  emptyCustomAgentDraft,
  type CustomAgentDraft,
  type CustomAgentDraftProblem,
} from "../model/custom-agent";
import { stateText } from "./agent-row";

type DraftCheck = { kind: "pending" } | { kind: "done"; result: AgentCheckDto };

function checkState(result: AgentCheckDto): AgentRowState {
  if (result.state !== "unavailable") return checkedState(result, true);
  if (result.reason.code === "executable_missing")
    return { kind: "command_missing", command: result.reason.executable };
  return { kind: "failed_to_start", message: result.reason.code };
}

// A rejected save in the words of the form: field problems stay at their
// field, the rest goes under the fields.
function saveProblem(error: AgentOperationError): {
  problem: CustomAgentDraftProblem | null;
  message: string | null;
} {
  switch (error.code) {
    case "name_missing":
      return { problem: { field: "name" }, message: null };
    case "command_missing":
      return { problem: { field: "command" }, message: null };
    case "invalid_variable":
      return {
        problem: { field: "env", line: error.name ?? "" },
        message: null,
      };
    default:
      return { problem: null, message: error.message };
  }
}

/**
 * Adding or editing a custom ACP agent: name, command, arguments and
 * variables, with a check of the command before it is saved. Secrets do
 * not belong here; the agent reads them from the login shell environment.
 */
export function CustomAgentDialog({
  editing,
  onCheck,
  onSave,
  onClose,
}: {
  /** The agent being edited; none adds a new one. */
  editing: CustomAgentSetupDto | null;
  onCheck: (
    agent: string | null,
    definition: CustomAgentDefinitionDto,
  ) => Promise<AgentCheckDto>;
  onSave: (
    agent: string | null,
    definition: CustomAgentDefinitionDto,
  ) => Promise<AgentOperationError | null>;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<CustomAgentDraft>(() =>
    editing ? customAgentDraft(editing) : emptyCustomAgentDraft(),
  );
  const [problem, setProblem] = useState<CustomAgentDraftProblem | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [check, setCheck] = useState<DraftCheck | null>(null);
  const [saving, setSaving] = useState(false);
  const agent = editing?.agent ?? null;

  const change = (field: keyof CustomAgentDraft, value: string) => {
    setDraft((current) => ({ ...current, [field]: value }));
    // A result describes the definition it checked, not the edited one.
    setCheck(null);
    setFailure(null);
    if (problem?.field === field) setProblem(null);
  };

  const definition = () => {
    const parsed = customAgentDefinition(draft);
    setProblem(parsed.problem);
    return parsed.definition;
  };

  const runCheck = async () => {
    const checked = definition();
    if (!checked) return;
    setCheck({ kind: "pending" });
    try {
      setCheck({ kind: "done", result: await onCheck(agent, checked) });
    } catch (error) {
      setCheck({
        kind: "done",
        result: {
          state: "failed_to_start",
          message: agentOperationError(error).message,
        },
      });
    }
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const saved = definition();
    if (!saved || saving) return;
    setSaving(true);
    const error = await onSave(agent, saved);
    setSaving(false);
    if (!error) return onClose();
    const rejected = saveProblem(error);
    setProblem(rejected.problem);
    setFailure(rejected.message);
  };

  const invalid = (field: CustomAgentDraftProblem["field"]) =>
    problem?.field === field;
  const checkLine =
    check?.kind === "pending"
      ? { state: null, text: m.settings_agents_pending_check() }
      : check
        ? (() => {
            const state = checkState(check.result);
            return { state, text: stateText(state) };
          })()
        : null;

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent data-custom-agent-form>
        <DialogHeader>
          <DialogTitle>
            {editing
              ? m.settings_agents_custom_edit_title()
              : m.settings_agents_custom_add_title()}
          </DialogTitle>
          <DialogDescription>
            {m.settings_agents_custom_description()}
          </DialogDescription>
        </DialogHeader>
        <form
          id="custom-agent-form"
          className="flex min-w-0 flex-col gap-4"
          onSubmit={(event) => void submit(event)}
        >
          <FieldGroup>
            <Field data-invalid={invalid("name") || undefined}>
              <FieldLabel htmlFor="custom-agent-name">
                {m.settings_agents_custom_name()}
              </FieldLabel>
              <Input
                id="custom-agent-name"
                autoFocus
                value={draft.name}
                aria-invalid={invalid("name")}
                onChange={(event) => change("name", event.target.value)}
              />
              {invalid("name") ? (
                <FieldError>
                  {m.settings_agents_custom_name_missing()}
                </FieldError>
              ) : null}
            </Field>
            <Field data-invalid={invalid("command") || undefined}>
              <FieldLabel htmlFor="custom-agent-command">
                {m.settings_agents_custom_command()}
              </FieldLabel>
              <Input
                id="custom-agent-command"
                value={draft.command}
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                aria-invalid={invalid("command")}
                onChange={(event) => change("command", event.target.value)}
              />
              <FieldDescription>
                {m.settings_agents_custom_command_description()}
              </FieldDescription>
              {invalid("command") ? (
                <FieldError>
                  {m.settings_agents_custom_command_missing()}
                </FieldError>
              ) : null}
            </Field>
            <Field>
              <FieldLabel htmlFor="custom-agent-args">
                {m.settings_agents_custom_args()}
              </FieldLabel>
              <Textarea
                id="custom-agent-args"
                rows={2}
                value={draft.args}
                spellCheck={false}
                className="font-mono"
                onChange={(event) => change("args", event.target.value)}
              />
              <FieldDescription>
                {m.settings_agents_custom_args_description()}
              </FieldDescription>
            </Field>
            <Field data-invalid={invalid("env") || undefined}>
              <FieldLabel htmlFor="custom-agent-env">
                {m.settings_agents_custom_env()}
              </FieldLabel>
              <Textarea
                id="custom-agent-env"
                rows={2}
                value={draft.env}
                spellCheck={false}
                className="font-mono"
                aria-invalid={invalid("env")}
                onChange={(event) => change("env", event.target.value)}
              />
              <FieldDescription>
                {m.settings_agents_custom_env_description()}
              </FieldDescription>
              {problem?.field === "env" ? (
                <FieldError>
                  {m.settings_agents_custom_env_invalid({ line: problem.line })}
                </FieldError>
              ) : null}
            </Field>
          </FieldGroup>
          {checkLine ? (
            <p
              data-custom-agent-check
              role="status"
              className={
                checkLine.state && checkLine.state.kind !== "checked"
                  ? "text-sm text-destructive wrap-break-word"
                  : "text-sm text-muted-foreground wrap-break-word"
              }
            >
              {checkLine.text}
            </p>
          ) : null}
          {failure ? (
            <Alert variant="destructive" className="min-w-0">
              <TriangleAlert data-icon="inline-start" />
              <AlertDescription className="min-w-0 break-words [overflow-wrap:anywhere]">
                {failure}
              </AlertDescription>
            </Alert>
          ) : null}
        </form>
        <DialogFooter className="sm:justify-between">
          <Button
            type="button"
            variant="outline"
            disabled={check?.kind === "pending"}
            onClick={() => void runCheck()}
          >
            {check?.kind === "pending" ? (
              <LoaderCircle data-icon="inline-start" className="animate-spin" />
            ) : null}
            {m.settings_agents_check()}
          </Button>
          <div className="flex flex-col-reverse gap-2 sm:flex-row">
            <Button type="button" variant="ghost" onClick={onClose}>
              {m.settings_agents_custom_cancel()}
            </Button>
            <Button type="submit" form="custom-agent-form" disabled={saving}>
              {saving ? (
                <LoaderCircle
                  data-icon="inline-start"
                  className="animate-spin"
                />
              ) : null}
              {editing
                ? m.settings_agents_custom_save()
                : m.settings_agents_custom_add_submit()}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
