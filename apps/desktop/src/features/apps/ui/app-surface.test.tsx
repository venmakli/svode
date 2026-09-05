import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
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
