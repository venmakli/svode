import { readFileSync } from "node:fs";
import { expect, test } from "bun:test";

const css = readFileSync(new URL("./conflict-lanes.css", import.meta.url), "utf8");

/** The custom properties a rule of `selector` sets, with their values. */
function tokens(selector: string): Map<string, string> {
  const start = css.indexOf(`${selector} {`);
  expect(start >= 0).toBe(true);
  const body = css.slice(start, css.indexOf("}", start));
  return new Map(
    [...body.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map(([, name, value]) => [
      name,
      value.trim(),
    ]),
  );
}

test("the dark theme sets every conflict colour of the light one, each its own", () => {
  const light = tokens("\n[data-conflict-lanes]");
  const dark = tokens(".dark [data-conflict-lanes]");
  expect([...dark.keys()]).toEqual([...light.keys()]);
  for (const [name, value] of light) expect(dark.get(name) === value).toBe(false);
  // The sides of «Изменения»: the conflict backgrounds of @pierre/diffs 1.1.7.
  expect(light.get("--conflict-ours")).toBe("#e5f8ea");
  expect(light.get("--conflict-theirs")).toBe("#e6f1ff");
  expect(dark.get("--conflict-ours")).toBe("#274432");
  expect(dark.get("--conflict-theirs")).toBe("#253b5a");
});
