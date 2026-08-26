import { expect, test } from "bun:test";
import type { ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { TooltipProvider } from "@/components/ui/tooltip";

import { RoutineAutomaticConsent } from "./routine-automatic-consent";

test("compact authority keeps exact owner semantics in its accessible label and tooltip", () => {
  for (const [ownerKind, label] of [
    ["project", "Automatic runs · Project"],
    ["space", "Automatic runs · Space"],
    ["collection", "Automatic runs · Collection"],
  ] as const) {
    const markup = renderAuthority({
      enabled: false,
      error: null,
      loading: false,
      ownerKind,
      pending: false,
      onChange: () => undefined,
    });
    const labelledControlId = markup.match(/<label[^>]*for="([^"]+)"/)?.[1];

    expect(markup.includes(label)).toBe(true);
    expect(markup.includes("this device")).toBe(true);
    expect(markup.includes("manual runs stay available")).toBe(true);
    expect(markup.includes('role="switch"')).toBe(true);
    expect(markup.includes(`aria-label="${label}"`)).toBe(true);
    expect(markup.includes("lucide-power")).toBe(true);
    expect(typeof labelledControlId).toBe("string");
    expect(markup.includes(`id="${labelledControlId}"`)).toBe(true);
    expect(markup.includes('data-orientation="vertical"')).toBe(false);
  }
});

test("loading authority keeps stable unknown geometry without an off switch", () => {
  const markup = renderAuthority({
    enabled: null,
    error: null,
    loading: true,
    ownerKind: "space",
    pending: false,
    onChange: () => undefined,
  });

  expect(
    markup.includes("Loading this owner&#x27;s device-local authority…"),
  ).toBe(true);
  expect(markup.includes('data-slot="skeleton"')).toBe(true);
  expect(markup.includes('role="switch"')).toBe(false);
});

test("unavailable authority keeps a disabled switch instead of changing control type", () => {
  const markup = renderAuthority({
    enabled: null,
    error: "Authority unavailable",
    loading: false,
    ownerKind: "collection",
    pending: false,
    onChange: () => undefined,
  });

  expect(markup.includes("Authority unavailable")).toBe(true);
  expect(markup.includes('role="switch"')).toBe(true);
  expect(markup.includes('aria-checked="false"')).toBe(true);
  expect(markup.includes('disabled=""')).toBe(true);
  expect(markup.includes('aria-invalid="true"')).toBe(true);
});

test("pending and save-error states preserve the confirmed switch value", () => {
  const pending = renderAuthority({
    enabled: true,
    error: null,
    loading: false,
    ownerKind: "project",
    pending: true,
    onChange: () => undefined,
  });
  const failed = renderAuthority({
    enabled: false,
    error: "write failed",
    loading: false,
    ownerKind: "project",
    pending: false,
    onChange: () => undefined,
  });

  expect(pending.includes('aria-checked="true"')).toBe(true);
  expect(pending.includes('aria-busy="true"')).toBe(true);
  expect(pending.includes("Saving…")).toBe(true);
  expect(failed.includes('aria-checked="false"')).toBe(true);
  expect(failed.includes('aria-invalid="true"')).toBe(true);
  expect(failed.includes("write failed")).toBe(true);
});

function renderAuthority(
  props: ComponentProps<typeof RoutineAutomaticConsent>,
) {
  return renderToStaticMarkup(
    <TooltipProvider>
      <RoutineAutomaticConsent {...props} />
    </TooltipProvider>,
  );
}
