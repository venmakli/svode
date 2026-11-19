import { expect, test } from "bun:test";
import { getLocale, setLocale } from "@/paraglide/runtime.js";
import { transferMegabytes } from "./transfer-size";

test("transferred sizes read in megabytes, with a decimal only below ten", async () => {
  const original = getLocale();
  try {
    await setLocale("en", { reload: false });
    expect(transferMegabytes(99_614_720)).toBe("95");
    expect(transferMegabytes(12_582_912)).toBe("12");
    expect(transferMegabytes(314_573)).toBe("0.3");
    expect(transferMegabytes(0)).toBe("0");
    await setLocale("ru", { reload: false });
    expect(transferMegabytes(314_573)).toBe("0,3");
    expect(transferMegabytes(419_430)).toBe("0,4");
  } finally {
    await setLocale(original, { reload: false });
  }
});
