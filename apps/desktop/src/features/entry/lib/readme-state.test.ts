import { expect, test } from "bun:test";
import { humanizeOwnerPath, isReadmeMissingError } from "./readme-state";

test("README owner state uses the directory name as fallback identity", () => {
  expect(humanizeOwnerPath("projects/design-system")).toBe("design system");
  expect(humanizeOwnerPath(".")).toBe("README");
});

test("README owner state classifies only path-specific missing errors", () => {
  expect(
    isReadmeMissingError(
      "File not found: projects/design/README.md",
      "projects/design/README.md",
    ),
  ).toBe(true);
  expect(
    isReadmeMissingError(
      "File not found: projects/other/README.md",
      "projects/design/README.md",
    ),
  ).toBe(false);
  expect(
    isReadmeMissingError(
      "Parser dependency not found for projects/design/README.md",
      "projects/design/README.md",
    ),
  ).toBe(false);
});
