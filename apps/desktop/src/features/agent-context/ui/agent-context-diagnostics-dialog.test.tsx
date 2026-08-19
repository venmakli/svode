import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { buildAgentContextDiagnosticReadModel } from "../model/diagnostics";
import {
  AgentContextDiagnosticList,
  AgentContextDiagnosticsDialog,
} from "./agent-context-diagnostics-dialog";

const rawMessage =
  "codex --version exited with Some(127): env: node: No such file or directory";
const groups = buildAgentContextDiagnosticReadModel({
  diagnostics: [
    {
      adapterId: "codex",
      code: "adapter_executable",
      message: rawMessage,
      path: null,
      severity: "warning",
    },
  ],
  refreshError: "source changed during scan",
});

test("trigger count is accessible and absent without diagnostics", () => {
  const trigger = renderToStaticMarkup(
    <AgentContextDiagnosticsDialog
      groups={groups}
      retrying={false}
      onRetry={() => undefined}
    />,
  );
  const empty = renderToStaticMarkup(
    <AgentContextDiagnosticsDialog
      groups={[]}
      retrying={false}
      onRetry={() => undefined}
    />,
  );

  expect(trigger.includes('aria-haspopup="dialog"')).toBe(true);
  expect(trigger.includes("Context diagnostics: 2")).toBe(true);
  expect(trigger.includes(">2<")).toBe(true);
  expect(empty).toBe("");
});

test("dialog list displays the exact grouped messages and structured metadata", () => {
  const markup = renderToStaticMarkup(
    <AgentContextDiagnosticList groups={groups} />,
  );

  expect(markup.includes(rawMessage)).toBe(true);
  expect(markup.includes("source changed during scan")).toBe(true);
  expect(markup.includes('data-agent-context-diagnostic-group="clients"')).toBe(
    true,
  );
  expect(markup.includes('data-agent-context-diagnostic-group="runtime"')).toBe(
    true,
  );
  expect(markup.includes("adapter_executable")).toBe(true);
  expect(markup.includes("codex")).toBe(true);
});
