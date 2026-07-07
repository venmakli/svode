import { expect, test } from "bun:test";
import {
  gitAuthChallengeFromRemoteUrl,
  isGitAuthRequiredError,
} from "./remote-auth";

test("gitAuthChallengeFromRemoteUrl redacts credentials and keeps scope", () => {
  const challenge = gitAuthChallengeFromRemoteUrl({
    remoteUrl: "https://user:secret@example.com/org/repo.git",
    operation: "clone",
    detail:
      "fatal: Authentication failed for https://user:secret@example.com/org/repo.git",
  });

  expect(challenge.operation).toBe("clone");
  expect(challenge.authMethod).toBe("https");
  expect(challenge.remoteUrl).toBe("https://***@example.com/org/repo.git");
  expect(challenge.host).toBe("example.com");
  expect(challenge.repository).toBe("org/repo");
  expect(challenge.detail?.includes("secret")).toBe(false);
});

test("isGitAuthRequiredError recognizes Tauri git auth errors", () => {
  expect(
    isGitAuthRequiredError("Git auth required: terminal prompts disabled"),
  ).toBe(true);
  expect(isGitAuthRequiredError("ordinary clone failure")).toBe(false);
});
