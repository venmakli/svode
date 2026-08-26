import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { RoutineTimezonePicker } from "./routine-timezone-picker";

test("timezone picker keeps local as the explicit default", () => {
  const markup = renderToStaticMarkup(
    <RoutineTimezonePicker
      id="routine-timezone"
      invalid={false}
      value={{ mode: "local" }}
      onChange={() => undefined}
    />,
  );
  expect(markup.includes('role="combobox"')).toBe(true);
  expect(markup.includes("Local time")).toBe(true);
  expect(markup.includes('aria-invalid="false"')).toBe(true);
});

test("timezone picker retains an unavailable fixed value for repair", () => {
  const markup = renderToStaticMarkup(
    <RoutineTimezonePicker
      id="routine-timezone"
      invalid
      value={{ mode: "fixed", timezone: "Mars/Olympus" }}
      onChange={() => undefined}
    />,
  );
  expect(markup.includes("Mars/Olympus")).toBe(true);
  expect(markup.includes('aria-invalid="true"')).toBe(true);
});
