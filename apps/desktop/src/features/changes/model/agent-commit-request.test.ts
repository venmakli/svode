import { expect, test } from "bun:test";
import * as m from "@/paraglide/messages.js";
import { setLocale } from "@/paraglide/runtime";
import type { GitUncommittedGroupsDto } from "@/platform/git/git-types";
import { agentCommitRequest, groupsByRepository } from "./agent-commit-request";

const root: GitUncommittedGroupsDto = {
  repository: "/p",
  groups: [
    {
      kind: "page",
      header: "Onboarding: edit of section “Prices”",
      facts: [],
      paths: ["Onboarding.md"],
      hidden: [],
    },
    {
      kind: "fields",
      header: "Tasks: BQ-12 and BQ-14 → “Done”",
      facts: ["Tasks: BQ-12 → “Done”", "Tasks: BQ-14 → “Done”"],
      paths: ["Tasks/BQ-12.md", "Tasks/BQ-14.md"],
      hidden: [],
    },
    {
      kind: "system",
      header: "Update Space settings",
      facts: [],
      paths: [".svode/config.json"],
      hidden: [],
    },
  ],
};
const sensitive: GitUncommittedGroupsDto = {
  repository: "/p",
  groups: [
    {
      kind: "fields",
      header: "Update 2 collection entries",
      facts: [],
      paths: [],
      hidden: [{ folder: "Contacts", files: 2 }],
    },
  ],
};
const docs: GitUncommittedGroupsDto = {
  repository: "/p/docs",
  groups: [
    {
      kind: "creation",
      header: "Create page “Guide”",
      facts: [],
      paths: ["Guide.md"],
      hidden: [],
    },
  ],
};

test("groups join by repository in the order repositories first appear", () => {
  const sections = groupsByRepository([
    root,
    docs,
    { repository: "/p/docs", groups: [] },
    sensitive,
  ]);
  expect(sections.map((section) => section.repository)).toEqual([
    "/p",
    "/p/docs",
  ]);
  expect(sections[0]!.groups.length).toBe(4);
  expect(groupsByRepository([{ repository: "/p", groups: [] }])).toEqual([]);
});

test("the request lists the groups with facts and explicit paths by repository, then every rule", () => {
  setLocale("en", { reload: false });
  const text = agentCommitRequest(groupsByRepository([root, docs]));
  const lines = text.split("\n");
  expect(lines[0]).toBe(m.agent_commit_request_intro());
  expect(
    text.includes(
      [
        m.agent_commit_request_repository({ path: "/p" }),
        "1. Onboarding: edit of section “Prices”",
        "   Files: `Onboarding.md`",
        "2. Tasks: BQ-12 and BQ-14 → “Done”",
        "   - Tasks: BQ-12 → “Done”",
        "   - Tasks: BQ-14 → “Done”",
        "   Files: `Tasks/BQ-12.md`, `Tasks/BQ-14.md`",
        `3. Update Space settings (${m.agent_commit_request_kind_system()})`,
        "   Files: `.svode/config.json`",
      ].join("\n"),
    ),
  ).toBe(true);
  expect(
    text.includes(
      [
        m.agent_commit_request_repository({ path: "/p/docs" }),
        "1. Create page “Guide”",
        "   Files: `Guide.md`",
      ].join("\n"),
    ),
  ).toBe(true);
  for (const rule of [
    m.agent_commit_request_rule_one_cause(),
    m.agent_commit_request_rule_no_mixing(),
    m.agent_commit_request_rule_explicit_paths(),
    m.agent_commit_request_rule_language(),
    m.agent_commit_request_rule_sensitive(),
    m.agent_commit_request_rule_no_agent(),
    m.agent_commit_request_rule_no_publish(),
  ]) {
    expect(lines.includes(`- ${rule}`)).toBe(true);
  }
  expect(
    text.indexOf(m.agent_commit_request_rules()) > text.indexOf("Guide.md"),
  ).toBe(true);
});

test("a sensitive Collection is named by its folder and file count only", () => {
  setLocale("en", { reload: false });
  const text = agentCommitRequest([sensitive]);
  expect(text.includes("1. Update 2 collection entries")).toBe(true);
  expect(
    text.includes(
      `   ${m.agent_commit_request_hidden({ folder: "`Contacts`", count: "2" })}`,
    ),
  ).toBe(true);
  expect(text.includes(m.agent_commit_request_files({ paths: "" }))).toBe(
    false,
  );
});

test("the request and its rule on message language follow the interface language", () => {
  setLocale("ru", { reload: false });
  const text = agentCommitRequest([root]);
  expect(text.includes("Репозиторий /p:")).toBe(true);
  expect(text.includes("- Пиши сообщения коммитов на русском.")).toBe(true);
  expect(text.includes("(системные настройки)")).toBe(true);
  setLocale("en", { reload: false });
  expect(
    agentCommitRequest([root]).includes("- Write commit messages in English."),
  ).toBe(true);
});
