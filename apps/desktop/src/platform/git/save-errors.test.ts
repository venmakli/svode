import { expect, test } from "bun:test";
import {
  isGitSavePartial,
  rethrowGitSaveError,
  toGitSaveFailureDto,
} from "./save-errors";

const failure = {
  kind: "git_save_failed",
  stage: "verify",
  reason: "paths_not_prepared",
  exitCode: null,
  pathCount: 2,
  pathSample: "Исследования/README.md",
};

test("manual save rejections reach every caller without raw output and retain access/partial contracts", () => {
  const denial = {
    kind: "repository_access_denied",
    repositoryId: "repo",
    status: "read_only",
    reason: "auth_required",
  };
  for (const [raw, expected] of [
    [{ ...failure, stderr: "SECRET" }, failure],
    [{ ...denial, message: "SECRET" }, denial],
    [
      { kind: "git_save_partial", cause: { ...denial, stderr: "SECRET" } },
      {
        kind: "git_save_partial",
        childCommitted: true,
        parentPointer: "pending",
        cause: denial,
      },
    ],
    [new Error("SECRET"), { kind: "git_save_unknown" }],
    [{ kind: "git_conflict", message: "SECRET" }, { kind: "git_conflict" }],
  ]) {
    let caught: unknown;
    try {
      rethrowGitSaveError(raw);
    } catch (error) {
      caught = error;
    }
    expect(caught).toEqual(expected);
    expect(JSON.stringify(caught).includes("SECRET")).toBe(false);
  }
});

test("Git save error boundary copies only controlled fields, including nested partial cause", () => {
  const raw = {
    ...failure,
    stderr: "SECRET",
    message: "/Users/private",
    stdout: "HOOK",
  };
  const dto = toGitSaveFailureDto(raw);
  expect(dto).toEqual({
    stage: "verify",
    reason: "paths_not_prepared",
    exitCode: null,
    pathCount: 2,
    pathSample: "Исследования/README.md",
  });
  expect(toGitSaveFailureDto({ kind: "git_save_partial", cause: raw })).toEqual(
    dto,
  );
  expect(isGitSavePartial({ kind: "git_save_partial", cause: "SECRET" })).toBe(
    true,
  );
});

test("unknown and malformed causes do not become access denial or raw diagnostics", () => {
  for (const raw of [
    "SECRET permission denied",
    new Error("SECRET"),
    null,
    { ...failure, stage: "SECRET" },
    { ...failure, reason: "SECRET" },
    { ...failure, pathCount: -1 },
    { ...failure, pathCount: Infinity },
    { kind: "git_save_partial", cause: { message: "SECRET" } },
  ])
    expect(toGitSaveFailureDto(raw)).toBeNull();
});

test("path samples remain bounded relative text and preserve literal Unicode names", () => {
  for (const pathSample of [
    "/Users/private/file",
    "C:/private/file",
    "~/private/file",
    "../file",
    "a/../../file",
    "https://user:SECRET@host",
    "a\\file",
    "a\nSECRET",
    "a\u202eSECRET",
    "a\0SECRET",
  ]) {
    expect(
      toGitSaveFailureDto({ ...failure, pathSample })?.pathSample,
    ).toBeNull();
  }
  const pathSample = `Исследования/${"я".repeat(300)}.md`;
  const result = toGitSaveFailureDto({
    ...failure,
    pathSample,
    exitCode: "SECRET",
  });
  expect(Array.from(result!.pathSample!).length).toBe(160);
  expect(result?.pathSample?.endsWith("…")).toBe(true);
  expect(result?.exitCode).toBeNull();
  expect(
    toGitSaveFailureDto({ ...failure, pathSample: "папка/[a]*.md" })
      ?.pathSample,
  ).toBe("папка/[a]*.md");
});
