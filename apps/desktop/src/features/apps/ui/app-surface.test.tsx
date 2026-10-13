import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { AppSession, AppVariablesProblem } from "../model/types";
import { AppViewport } from "./app-surface";

test("ready App viewport is sandboxed and does not grant host navigation", () => {
  const html = renderToStaticMarkup(
    <AppViewport
      session={{
        status: "ready",
        ownerDirectory: "/repo/dashboard",
        runtimeType: "url",
        viewportUrl: "https://example.com/dashboard",
      }}
      onRetry={() => undefined}
      onRestart={() => undefined}
      onStop={() => undefined}
      onRerunSetup={() => undefined}
      onShowFiles={() => undefined}
      onOpenBrowser={() => undefined}
    />,
  );

  expect(html.includes("<iframe")).toBe(true);
  expect(html.includes("allow-same-origin")).toBe(true);
  expect(html.includes("allow-scripts")).toBe(true);
  expect(html.includes("allow-top-navigation")).toBe(false);
  expect(html.includes('allow="')).toBe(false);
});

test("invalid manifest recovery stays inside the App surface", () => {
  const html = renderToStaticMarkup(
    <AppViewport
      session={{
        status: "invalid",
        ownerDirectory: "/repo/dashboard",
        diagnostics: [
          {
            code: "unknown_field",
            path: "runtime.label",
            message: "Unknown field: label",
          },
        ],
      }}
      onRetry={() => undefined}
      onRestart={() => undefined}
      onStop={() => undefined}
      onRerunSetup={() => undefined}
      onShowFiles={() => undefined}
      onOpenBrowser={() => undefined}
    />,
  );

  expect(html.includes("runtime.label")).toBe(true);
  expect(html.includes("Unknown field: label")).toBe(true);
  expect(html.includes("button")).toBe(true);
});

test("process launch keeps progress, stop, and logs inside the App surface", () => {
  const html = renderToStaticMarkup(
    <AppViewport
      session={{
        status: "launching",
        ownerDirectory: "/repo/dashboard",
        runtimeType: "process",
        phase: "waiting_for_url",
        browserUrl: "http://127.0.0.1:43000",
        process: {
          managed: true,
          hasSetup: true,
          logs: { stdout: "server booting", stderr: "" },
        },
      }}
      onRetry={() => undefined}
      onRestart={() => undefined}
      onStop={() => undefined}
      onRerunSetup={() => undefined}
      onShowFiles={() => undefined}
      onOpenBrowser={() => undefined}
    />,
  );

  expect(html.includes("Waiting for the App interface")).toBe(true);
  expect(html.includes("Logs")).toBe(true);
  expect(html.includes("Stop")).toBe(true);
});

test("process failure exposes logs and explicit setup recovery", () => {
  const html = renderToStaticMarkup(
    <AppViewport
      session={{
        status: "unavailable",
        ownerDirectory: "/repo/dashboard",
        runtimeType: "process",
        reason: "setup_non_zero_exit",
        browserUrl: "http://127.0.0.1:43000",
        process: {
          managed: false,
          hasSetup: true,
          logs: { stdout: "", stderr: "dependency install failed" },
        },
      }}
      onRetry={() => undefined}
      onRestart={() => undefined}
      onStop={() => undefined}
      onRerunSetup={() => undefined}
      onShowFiles={() => undefined}
      onOpenBrowser={() => undefined}
    />,
  );

  expect(html.includes("App preparation failed")).toBe(true);
  expect(html.includes("Logs")).toBe(true);
  expect(html.includes("Run setup again")).toBe(true);
});

test("missing Variables block launch and expose contextual Settings recovery", () => {
  const html = renderToStaticMarkup(
    <AppViewport
      session={{
        status: "unavailable",
        ownerDirectory: "/repo/dashboard",
        runtimeType: "process",
        reason: "missing_app_variables",
        browserUrl: "http://127.0.0.1:43000",
        process: {
          managed: false,
          hasSetup: true,
          logs: { stdout: "", stderr: "" },
        },
        missingVariables: [
          { referenceName: "API_TOKEN", entryName: "API_TOKEN" },
          { referenceName: "DATABASE_URL", entryName: "DATABASE_URL" },
        ],
      }}
      onRetry={() => undefined}
      onRestart={() => undefined}
      onStop={() => undefined}
      onRerunSetup={() => undefined}
      onShowFiles={() => undefined}
      onOpenBrowser={() => undefined}
      onVariables={() => undefined}
    />,
  );

  expect(html.includes("API_TOKEN, DATABASE_URL")).toBe(true);
  expect(html.includes(">Variables<")).toBe(true);
  expect(html.includes(">Retry<")).toBe(false);
});

function unreadableSession(
  variablesProblem: AppVariablesProblem,
): Extract<AppSession, { status: "unavailable"; runtimeType: "process" }> {
  return {
    status: "unavailable",
    ownerDirectory: "/repo/dashboard",
    runtimeType: "process",
    reason: "unreadable_app_variables",
    browserUrl: "http://127.0.0.1:43000",
    process: {
      managed: false,
      hasSetup: true,
      logs: { stdout: "", stderr: "" },
    },
    variablesProblem,
  };
}

function renderRecovery(session: AppSession) {
  return renderToStaticMarkup(
    <AppViewport
      session={session}
      onRetry={() => undefined}
      onRestart={() => undefined}
      onStop={() => undefined}
      onRerunSetup={() => undefined}
      onShowFiles={() => undefined}
      onOpenBrowser={() => undefined}
      onVariables={() => undefined}
    />,
  );
}

test("unreadable Variables name their cause instead of missing names", () => {
  const html = renderRecovery(
    unreadableSession({
      category: "legacy_format",
      owner: { scope: "global" },
      file: "/library/settings.json",
    }),
  );

  expect(html.includes("read variables")).toBe(true);
  expect(
    html.includes("Svode shared settings are saved in an unsupported format."),
  ).toBe(true);
  expect(html.includes("the App won")).toBe(true);
  expect(html.includes("needs Variables")).toBe(false);
  expect(html.includes("settings.json")).toBe(false);
  const variables = html.indexOf(">Variables<");
  const checkAgain = html.indexOf(">Check again<");
  expect(variables > -1).toBe(true);
  expect(checkAgain > variables).toBe(true);
  expect(html.includes(">Retry<")).toBe(false);
  expect(html.includes("Run setup again")).toBe(false);
  expect(html.includes("Show files")).toBe(true);
});

test("unreadable Variables describe each category within its area", () => {
  expect(
    renderRecovery(
      unreadableSession({
        category: "pending_save",
        owner: { scope: "project" },
        file: "/repo/.svode/variables.pending.json",
      }),
    ).includes("Project variables are blocked by an unfinished save."),
  ).toBe(true);
  expect(
    renderRecovery(
      unreadableSession({
        category: "unavailable",
        owner: { scope: "project" },
        file: null,
      }),
    ).includes("The secret store can"),
  ).toBe(true);
  const unknown = renderRecovery(
    unreadableSession({
      category: "unknown",
      owner: { scope: "space" },
      file: null,
    }),
  );
  expect(unknown.includes("Space variables couldn")).toBe(true);
  expect(unknown.includes("format")).toBe(false);
});
