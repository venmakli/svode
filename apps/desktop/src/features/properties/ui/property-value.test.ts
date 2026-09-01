import { expect, test } from "bun:test";

import { formatBytes } from "./property-value";

test("formats byte-backed number properties for collection tables", () => {
  expect(formatBytes(0)).toBe("0 B");
  expect(formatBytes(1023)).toBe("1023 B");
  expect(formatBytes(1024)).toBe("1 KB");
  expect(formatBytes(1_572_864)).toBe("1.5 MB");
  expect(formatBytes(5_368_709_120)).toBe("5 GB");
});
