import { expect, test } from "bun:test";
import * as m from "@/paraglide/messages.js";
import { setLocale } from "@/paraglide/runtime";
import { conflictsForAgent } from "../model/conflict-agent-request";
import { conflictAgentRequest } from "./conflict-agent-request";
import {
  gitConflictKindLabel,
  gitOperationAbortCopy,
} from "./git-sync-stop-copy";

const RULES = "Git in a Svode project:\n- The Svode app commits and syncs.\n";

const names: Record<string, string> = {
  "Onboarding.md": "Onboarding",
  "tasks/schema.yaml": "Collection schema “Tasks”",
};
const nameOf = (path: string) => names[path] ?? path.split("/").at(-1)!;

test("the agent gets the unresolved conflicts once each and no Svode service file", () => {
  const conflicts = conflictsForAgent(
    [
      "Onboarding.md",
      ".svode/order.json",
      "a.md",
      "b.md",
      "c.md",
      "tasks/schema.yaml",
      "data.bin",
      "projects",
    ],
    [
      { path: "Onboarding.md", kind: "page_text" },
      { path: ".svode/order.json", kind: "text" },
      // rename/rename: my name is the entry, the original and the incoming
      // name are resolved with it.
      { path: "b.md", kind: "rename_rename", also: ["a.md", "c.md"] },
      { path: "tasks/schema.yaml", kind: "text" },
      { path: "data.bin", kind: "binary" },
      { path: "projects", kind: "space_pointer" },
    ],
    [
      { path: ".svode/order.json", state: "mergeable" },
      { path: "projects", state: "space_diverged" },
    ],
  );
  expect(conflicts).toEqual([
    { path: "Onboarding.md", also: [], kind: "page_text" },
    { path: "b.md", also: ["a.md", "c.md"], kind: "rename_rename" },
    { path: "tasks/schema.yaml", also: [], kind: "text" },
    { path: "data.bin", also: [], kind: "binary" },
  ]);
  // A path whose kind is not known yet is still handed over.
  expect(conflictsForAgent(["notes.txt"], [])).toEqual([
    { path: "notes.txt", also: [], kind: undefined },
  ]);
});

test("the request names the paths with their names and kinds, then the Git rules", async () => {
  for (const locale of ["en", "ru"] as const) {
    await setLocale(locale, { reload: false });
    const conflicts = conflictsForAgent(
      ["Onboarding.md", "a.md", "b.md", "tasks/schema.yaml", "data.bin"],
      [
        { path: "Onboarding.md", kind: "page_text" },
        { path: "b.md", kind: "rename_rename", also: ["a.md"] },
        { path: "tasks/schema.yaml", kind: "text" },
        { path: "data.bin", kind: "binary" },
      ],
    );
    const merge = conflictAgentRequest({
      repository: "/p/space",
      situation: { kind: "merge" },
      conflicts,
      nameOf,
      rules: RULES,
    });
    expect(merge.split("\n")).toEqual([
      m.agent_conflict_request_merge({ path: "/p/space" }),
      "",
      m.agent_conflict_request_files(),
      `- Onboarding: \`Onboarding.md\` (${gitConflictKindLabel("page_text")})`,
      `- \`b.md\`, \`a.md\` (${gitConflictKindLabel("rename_rename")})`,
      `- Collection schema “Tasks”: \`tasks/schema.yaml\` (${gitConflictKindLabel("text")})`,
      `- \`data.bin\` (${gitConflictKindLabel("binary")})`,
      "",
      "Git in a Svode project:",
      "- The Svode app commits and syncs.",
    ]);

    const unmerged = conflictAgentRequest({
      repository: "/p",
      situation: { kind: "unmerged" },
      conflicts: conflictsForAgent(["notes.txt"], []),
      nameOf,
      rules: RULES,
    });
    expect(unmerged.split("\n").slice(0, 4)).toEqual([
      m.agent_conflict_request_unmerged({ path: "/p" }),
      "",
      m.agent_conflict_request_files(),
      "- `notes.txt`",
    ]);
  }
  await setLocale("en", { reload: false });
});

test("the request at an operation names it with its step and files, and leaves the decision to the person", async () => {
  for (const locale of ["en", "ru"] as const) {
    await setLocale(locale, { reload: false });
    const rebase = conflictAgentRequest({
      repository: "/p/space",
      situation: {
        kind: "operation",
        operation: "rebase",
        step: { kind: "position", current: 2, total: 5 },
      },
      conflicts: conflictsForAgent(
        ["Onboarding.md"],
        [{ path: "Onboarding.md", kind: "page_text" }],
      ),
      nameOf,
      rules: RULES,
    });
    expect(rebase.split("\n")).toEqual([
      m.agent_operation_request({ operation: "rebase", path: "/p/space" }),
      m.agent_operation_request_position({ current: "2", total: "5" }),
      "",
      m.agent_conflict_request_files(),
      `- Onboarding: \`Onboarding.md\` (${gitConflictKindLabel("page_text")})`,
      "",
      "Git in a Svode project:",
      "- The Svode app commits and syncs.",
    ]);

    const sequence = conflictAgentRequest({
      repository: "/p",
      situation: {
        kind: "operation",
        operation: "revert",
        step: { kind: "remaining", count: 3 },
      },
      conflicts: [],
      nameOf,
      rules: RULES,
    });
    expect(sequence.split("\n")).toEqual([
      m.agent_operation_request({ operation: "revert", path: "/p" }),
      m.agent_operation_request_remaining({ count: "3" }),
      "",
      "Git in a Svode project:",
      "- The Svode app commits and syncs.",
    ]);

    // A single pick: no step reported.
    const pick = conflictAgentRequest({
      repository: "/p",
      situation: { kind: "operation", operation: "cherry_pick", step: null },
      conflicts: conflictsForAgent(["notes.txt"], []),
      nameOf,
      rules: RULES,
    });
    expect(pick.split("\n").slice(0, 4)).toEqual([
      m.agent_operation_request({ operation: "cherry-pick", path: "/p" }),
      "",
      m.agent_conflict_request_files(),
      "- `notes.txt`",
    ]);
  }
  await setLocale("en", { reload: false });
});

test("the confirmation of each operation names what is lost and what stays", async () => {
  for (const locale of ["en", "ru"] as const) {
    await setLocale(locale, { reload: false });
    for (const [operation, name] of [
      ["rebase", "rebase"],
      ["cherry_pick", "cherry-pick"],
      ["revert", "revert"],
    ] as const) {
      const single = gitOperationAbortCopy(operation, null);
      expect(single.action).toBe(
        m.git_operation_abort_action({ operation: name }),
      );
      expect(single.title).toBe(
        m.git_operation_abort_title({ action: single.action }),
      );
      expect(single.description).toBe(
        m.git_operation_abort_description({ operation: name }),
      );
    }
    // A rebase reports its position; it is not a sequence of picks.
    expect(
      gitOperationAbortCopy("rebase", {
        kind: "position",
        current: 1,
        total: 3,
      }).description,
    ).toBe(m.git_operation_abort_description({ operation: "rebase" }));
    // A pick or revert with a todo, and the sequencer, return the branch to
    // before the whole sequence: the commits it applied are lost too.
    for (const copy of [
      gitOperationAbortCopy("cherry_pick", { kind: "remaining", count: 2 }),
      gitOperationAbortCopy("revert", { kind: "remaining", count: 1 }),
      gitOperationAbortCopy("sequencer", null),
    ])
      expect(copy.description).toBe(
        m.git_operation_abort_sequence_description(),
      );
    expect(gitOperationAbortCopy("sequencer", null).action).toBe(
      m.git_operation_abort_sequence_action(),
    );
    // Only a sequence lists the commits it drops; none when it dropped none.
    for (const operation of ["rebase", "cherry_pick", "revert"] as const)
      expect(gitOperationAbortCopy(operation, null).dropped).toBe(undefined);
    expect(
      gitOperationAbortCopy(
        "cherry_pick",
        { kind: "remaining", count: 1 },
        { head: "c0ffee", count: 0, titles: [] },
      ).dropped,
    ).toBe(undefined);
    expect(
      gitOperationAbortCopy("revert", null, {
        head: "c0ffee",
        count: 2,
        titles: ["Resolve conflict", "Add intro"],
      }),
    ).toEqual({
      action: m.git_operation_abort_action({ operation: "revert" }),
      title: m.git_operation_abort_title({
        action: m.git_operation_abort_action({ operation: "revert" }),
      }),
      description: m.git_operation_abort_sequence_description(),
      dropped: {
        summary: m.git_operation_abort_sequence_commits({ count: "2" }),
        titles: ["Resolve conflict", "Add intro"],
        more: null,
      },
    });
  }
  await setLocale("en", { reload: false });
});
