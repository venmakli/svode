import { expect, test } from "bun:test";

import {
  actorManualSaveFeedback,
  actorMutationPersistenceFeedback,
} from "./persistence-feedback";

test("mutation feedback keeps child success and root policy pending independent", () => {
  const feedback = actorMutationPersistenceFeedback({
    canonicalEmail: "actor@example.test",
    catalog: {
      diagnostics: [],
      generation: 2,
      repositoryId: "/child",
      rows: [],
      shallow: false,
    },
    currentIdentityUpdated: true,
    persistence: {
      mailmap: { status: "committed" },
      rootPointer: { reason: "policy_off", status: "pending" },
    },
    status: "applied",
  });

  expect(feedback.tone).toBe("warning");
  expect(feedback.title.includes(".mailmap committed")).toBe(true);
  expect(
    feedback.description?.includes("structural autocommit is disabled"),
  ).toBe(true);
  expect(feedback.description?.includes("repository-local Git identity")).toBe(
    true,
  );
});

test("manual feedback reports pointer-only recovery as success", () => {
  const feedback = actorManualSaveFeedback({
    mailmap: { status: "clean" },
    rootPointer: { status: "committed" },
  });

  expect(feedback.tone).toBe("success");
  expect(feedback.title.includes("pending root submodule pointer")).toBe(true);
});

test("manual feedback preserves child commit when the root pointer fails", () => {
  const feedback = actorManualSaveFeedback({
    mailmap: { status: "committed" },
    rootPointer: { message: "hook rejected", status: "failed" },
  });

  expect(feedback.tone).toBe("warning");
  expect(feedback.title.includes(".mailmap commit")).toBe(true);
  expect(feedback.description?.includes("hook rejected")).toBe(true);
});
