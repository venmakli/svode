import { useId, useLayoutEffect, useRef, useState, type Ref } from "react";
import { CircleAlert, LoaderCircle } from "lucide-react";
import * as m from "@/paraglide/messages.js";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent } from "@/components/ui/collapsible";
import type { VariablesAttempt } from "../hooks/use-app-variables";
import {
  isSharedProblem,
  type VariablesProblem,
  type VariablesProblemCategory,
} from "../model/app-variables";

const titles: Record<VariablesProblemCategory, () => string> = {
  unavailable: m.variables_problem_title_unavailable,
  legacy_format: m.variables_problem_title_legacy_format,
  invalid_config: m.variables_problem_title_invalid_config,
  blocked_journal: m.variables_problem_title_blocked_journal,
  pending_save: m.variables_problem_title_pending_save,
  unknown: m.variables_problem_title_unknown,
};

function reason(problem: VariablesProblem) {
  switch (problem.category) {
    case "unavailable":
      return problem.file
        ? m.variables_problem_reason_unavailable_file()
        : m.variables_problem_reason_unavailable_store();
    case "legacy_format":
      return m.variables_problem_reason_legacy_format();
    case "invalid_config":
      return m.variables_problem_reason_invalid_config();
    case "blocked_journal":
      return m.variables_problem_reason_blocked_journal();
    case "pending_save":
      return m.variables_problem_reason_pending_save();
    case "unknown":
      return m.variables_problem_reason_unknown();
  }
}

const results: Record<
  Exclude<VariablesAttempt["state"], "pending">,
  () => string
> = {
  failed: m.variables_problem_result_reload_failed,
  finished_unreadable: m.variables_problem_result_finished_unreadable,
  nothing_pending: m.variables_problem_result_nothing_pending,
};

function resultText(attempt: VariablesAttempt | null) {
  if (!attempt) return "";
  if (attempt.state === "pending")
    return attempt.action === "reload"
      ? m.variables_problem_loading()
      : m.variables_problem_finishing();
  return attempt.action === "recover" && attempt.state === "failed"
    ? m.variables_problem_result_recover_failed()
    : results[attempt.state]();
}

// Manual repair steps for the shown cause; this surface never writes files.
// Text blocks are divs: AlertDescription spaces paragraphs for prose.
function Instructions({
  problem,
  area,
}: {
  problem: VariablesProblem;
  area?: string;
}) {
  const section = problem.section;
  return (
    <div className="flex flex-col gap-2 text-sm">
      {problem.file ? (
        <div className="font-mono text-xs wrap-anywhere text-foreground">
          {m.variables_problem_file({ file: problem.file })}
          {section ? (
            <>
              <br />
              {m.variables_problem_section({ section })}
            </>
          ) : null}
        </div>
      ) : null}
      {problem.category === "legacy_format" ? (
        <>
          <div>{m.variables_problem_fix_legacy_intro()}</div>
          <ol className="flex list-decimal flex-col gap-1 pl-5">
            <li>{m.variables_problem_fix_legacy_close()}</li>
            <li>{m.variables_problem_fix_legacy_keep()}</li>
            <li>
              {m.variables_problem_fix_legacy_remove({
                section: section ?? "variables",
              })}
            </li>
            <li>{m.variables_problem_fix_legacy_setup()}</li>
          </ol>
          {section === "appVariableRegistry" ? (
            <div>{m.variables_problem_fix_legacy_registry()}</div>
          ) : isSharedProblem(problem) ? (
            <div>{m.variables_problem_fix_legacy_global()}</div>
          ) : null}
        </>
      ) : problem.category === "invalid_config" ? (
        <div>{m.variables_problem_fix_invalid_config()}</div>
      ) : problem.category === "blocked_journal" ? (
        <div>{m.variables_problem_fix_blocked_journal()}</div>
      ) : problem.category === "pending_save" ? (
        <div>{m.variables_problem_fix_pending_save()}</div>
      ) : problem.category === "unavailable" ? (
        <div>
          {problem.file
            ? m.variables_problem_fix_unavailable_file()
            : m.variables_problem_fix_unavailable_store()}
        </div>
      ) : (
        <>
          <div>{m.variables_problem_fix_unknown()}</div>
          <div className="font-mono text-xs wrap-anywhere text-foreground">
            {m.variables_problem_area({
              area: isSharedProblem(problem)
                ? m.variables_problem_area_shared()
                : (area ?? "—"),
            })}
            {problem.code ? (
              <>
                <br />
                {m.variables_problem_code({ code: problem.code })}
              </>
            ) : null}
          </div>
        </>
      )}
    </div>
  );
}

// One unreadable catalog or owner: cause, the single applicable primary
// action, a quiet secondary one and inline repair details (DF-114 R2).
export function VariablesProblemCallout({
  ref,
  problem,
  attempt,
  label,
  disabled = false,
  onRetry,
  onRecover,
  focusFallback,
}: {
  ref?: Ref<HTMLDivElement>;
  problem: VariablesProblem;
  attempt: VariablesAttempt | null;
  // Names the owner on surfaces that list several of them.
  label?: string;
  disabled?: boolean;
  onRetry(): void;
  onRecover(): void;
  focusFallback?(): HTMLElement | null | undefined;
}) {
  const [open, setOpen] = useState(false);
  const detailsId = useId();
  const root = useRef<HTMLDivElement | null>(null);
  const acted = useRef(false);
  const fallback = useRef(focusFallback);
  const pending = attempt?.state === "pending";
  const recover = problem.recoverable && Boolean(problem.owner);
  const manual =
    problem.category === "legacy_format" ||
    problem.category === "invalid_config" ||
    problem.category === "blocked_journal";
  const toggle = () => setOpen((value) => !value);
  const retryLabel =
    attempt?.action === "reload" && pending
      ? m.variables_problem_loading()
      : manual
        ? m.variables_problem_check_again()
        : m.variables_problem_retry();
  const status = resultText(attempt);

  // A finished action may replace the pressed control; keep focus in the
  // callout, or hand it to the catalog when the callout itself goes away.
  useLayoutEffect(() => {
    fallback.current = focusFallback;
    if (!acted.current || pending) return;
    acted.current = false;
    const active = document.activeElement;
    if (!active || active === document.body || !active.isConnected)
      root.current?.focus();
  });
  useLayoutEffect(
    () => () => {
      if (!acted.current && !root.current?.contains(document.activeElement))
        return;
      queueMicrotask(() => {
        const active = document.activeElement;
        if (!active || active === document.body || !active.isConnected)
          fallback.current?.()?.focus();
      });
    },
    [],
  );

  const act = (action: () => void) => () => {
    acted.current = true;
    action();
  };
  const spinner = pending ? (
    <LoaderCircle data-icon="inline-start" className="animate-spin" />
  ) : null;
  const primary = recover ? (
    <Button
      key="primary"
      type="button"
      variant="outline"
      size="sm"
      disabled={disabled || pending}
      onClick={act(onRecover)}
    >
      {attempt?.action === "recover" ? spinner : null}
      {attempt?.action === "recover" && pending
        ? m.variables_problem_finishing()
        : m.variables_problem_finish()}
    </Button>
  ) : manual ? (
    <Button
      key="primary"
      type="button"
      variant="outline"
      size="sm"
      aria-expanded={open}
      aria-controls={detailsId}
      onClick={toggle}
    >
      {m.variables_problem_how_to_fix()}
    </Button>
  ) : (
    <Button
      key="primary"
      type="button"
      variant="outline"
      size="sm"
      disabled={disabled || pending}
      onClick={act(onRetry)}
    >
      {attempt?.action === "reload" ? spinner : null}
      {retryLabel}
    </Button>
  );
  const secondary = manual ? (
    <Button
      key="secondary"
      type="button"
      variant="ghost"
      size="sm"
      disabled={disabled || pending}
      onClick={act(onRetry)}
    >
      {attempt?.action === "reload" ? spinner : null}
      {retryLabel}
    </Button>
  ) : (
    <Button
      key="secondary"
      type="button"
      variant="ghost"
      size="sm"
      aria-expanded={open}
      aria-controls={detailsId}
      onClick={toggle}
    >
      {m.variables_problem_details()}
    </Button>
  );

  return (
    <Alert
      ref={(node) => {
        root.current = node;
        if (typeof ref === "function") ref(node);
        else if (ref) ref.current = node;
      }}
      tabIndex={-1}
      aria-busy={pending || undefined}
      data-problem={problem.category}
      className="outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
    >
      <CircleAlert />
      <AlertTitle>{titles[problem.category]()}</AlertTitle>
      <AlertDescription className="flex min-w-0 flex-col gap-2">
        <div className="wrap-anywhere">
          {label ? `${label}: ` : ""}
          {reason(problem)}
          {isSharedProblem(problem) ? ` ${m.variables_problem_shared()}` : ""}
        </div>
        <Collapsible
          open={open}
          onOpenChange={setOpen}
          className="flex min-w-0 flex-col gap-2"
        >
          <div className="flex flex-wrap gap-2">
            {primary}
            {secondary}
          </div>
          <div
            role="status"
            className={status ? "text-sm text-foreground" : "sr-only"}
          >
            {status}
          </div>
          <CollapsibleContent id={detailsId}>
            <Instructions problem={problem} area={label} />
          </CollapsibleContent>
        </Collapsible>
      </AlertDescription>
    </Alert>
  );
}
