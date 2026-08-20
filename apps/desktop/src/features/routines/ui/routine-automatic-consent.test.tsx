import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { RoutineAutomaticConsent } from "./routine-automatic-consent";

test("automatic authority labels the exact owner type before interaction", () => {
  for (const [ownerKind, label] of [
    ["project", "Automatic runs · Project"],
    ["space", "Automatic runs · Space"],
    ["collection", "Automatic runs · Collection"],
  ] as const) {
    const markup = renderToStaticMarkup(
      <RoutineAutomaticConsent
        enabled={false}
        error={null}
        loading={false}
        ownerKind={ownerKind}
        pending={false}
        onChange={() => undefined}
      />,
    );

    expect(markup.includes(label)).toBe(true);
    expect(markup.includes("this device")).toBe(true);
    expect(markup.includes("manual runs remain available")).toBe(true);
  }
});

test("loading authority stays unknown and disabled", () => {
  const markup = renderToStaticMarkup(
    <RoutineAutomaticConsent
      enabled={null}
      error={null}
      loading
      ownerKind="space"
      pending={false}
      onChange={() => undefined}
    />,
  );

  expect(markup.includes('aria-busy="true"')).toBe(true);
  expect(
    markup.includes("Loading this owner&#x27;s device-local authority…"),
  ).toBe(true);
  expect(markup.includes("disabled")).toBe(true);
});

test("unavailable authority cannot be changed from an unconfirmed value", () => {
  const markup = renderToStaticMarkup(
    <RoutineAutomaticConsent
      enabled={null}
      error="Authority unavailable"
      loading={false}
      ownerKind="collection"
      pending={false}
      onChange={() => undefined}
    />,
  );

  expect(markup.includes("Authority unavailable")).toBe(true);
  expect(markup.includes("disabled")).toBe(true);
  expect(markup.includes('aria-invalid="true"')).toBe(true);
});
