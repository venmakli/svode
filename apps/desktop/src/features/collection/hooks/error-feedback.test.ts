import * as bunTest from "bun:test";
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Module mocks stay for the whole process, so the scenarios run in their own.
if (process.env.SVODE_COLLECTION_ERROR_FEEDBACK_PROCESS !== "1") {
  test("Collection item error feedback", () => {
    const child = spawnSync(
      process.execPath,
      ["test", fileURLToPath(import.meta.url)],
      {
        env: { ...process.env, SVODE_COLLECTION_ERROR_FEEDBACK_PROCESS: "1" },
        encoding: "utf8",
      },
    );
    if (child.status !== 0) {
      throw new Error([child.stdout, child.stderr].filter(Boolean).join("\n"));
    }
    expect(child.status).toBe(0);
  }, 60_000);
} else {
  const { mock } = bunTest;
  const { setLocale } = await import("@/paraglide/runtime.js");
  const toastErrors: unknown[] = [];
  mock.module("sonner", () => ({
    toast: {
      error: (message: unknown) => toastErrors.push(message),
      success: () => undefined,
      warning: () => undefined,
    },
  }));
  const { handleItemCreateError, handleItemMoveError } =
    await import("./error-feedback");
  const takenName = {
    kind: "file_already_exists",
    message: "File already exists: Tasks/Plan.md",
    path: "Tasks/Plan.md",
  };

  test("a taken name of a new item names the name and the Collection folder", async () => {
    const error = console.error;
    console.error = () => undefined;
    try {
      toastErrors.length = 0;
      await setLocale("en", { reload: false });
      handleItemCreateError(takenName, "Docs");
      await setLocale("ru", { reload: false });
      handleItemCreateError(takenName, "Docs");
      await setLocale("en", { reload: false });
      handleItemCreateError("IO error: denied", "Docs");
    } finally {
      console.error = error;
    }
    expect(toastErrors).toEqual([
      "“Plan.md” is already taken in “Tasks”.",
      "Имя «Plan.md» уже занято в «Tasks».",
      "Could not create card.",
    ]);
  });

  test("a taken name of a moved item names itself, other errors keep the move text", async () => {
    toastErrors.length = 0;
    await setLocale("en", { reload: false });
    handleItemMoveError(takenName, "Docs");
    handleItemMoveError("IO error: denied", "Docs");
    expect(toastErrors).toEqual([
      "“Plan.md” is already taken in “Tasks”.",
      "Could not move card.",
    ]);
  });
}
