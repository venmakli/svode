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
      onShowFiles={() => undefined}
      onOpenBrowser={() => undefined}
    />,
  );

  expect(html.includes("runtime.label")).toBe(true);
  expect(html.includes("Unknown field: label")).toBe(true);
  expect(html.includes("button")).toBe(true);
});
