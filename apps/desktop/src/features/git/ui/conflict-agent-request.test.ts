import { expect, test } from "bun:test";
import * as m from "@/paraglide/messages.js";
import { setLocale } from "@/paraglide/runtime";
import { conflictsForAgent } from "../model/conflict-agent-request";
import { conflictAgentRequest } from "./conflict-agent-request";
import { gitConflictKindLabel } from "./git-sync-stop-copy";

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
