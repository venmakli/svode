import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";
import { setLocale } from "@/paraglide/runtime";
import type { AvailableAgent } from "../model";
import { SpaceAgentSection } from "./space-agent-section";
import { SpaceDefaultsSection } from "./space-defaults-section";
import { SpaceInstructionsSection } from "./space-instructions-section";

const noop = () => {};

const agents: AvailableAgent[] = [
  {
    name: "claude",
    path: "/usr/local/bin/claude",
    version: "2.1.0",
    authStatus: "authorized",
    docsUrl: "https://example.test/claude",
  },
  {
    name: "codex",
    path: "",
    version: null,
    authStatus: "not_found",
    docsUrl: "https://example.test/codex",
  },
];

function render(element: React.ReactElement) {
  return new JSDOM(renderToStaticMarkup(element)).window.document;
}

function groupTitles(document: Document) {
  return Array.from(document.querySelectorAll("body > section")).map(
    (group) => group.querySelector("h3")?.textContent ?? null,
  );
}

// Each group is one bordered card; no row carries a card of its own.
function expectOneCardPerGroup(document: Document) {
  for (const group of document.querySelectorAll("body > section")) {
    const cards = group.querySelectorAll('[data-slot="card"]');
    expect(cards.length).toBe(1);
    expect(cards[0].querySelector('[data-slot="card"]')).toBeNull();
  }
}

test("AI agent: chat group with the model select and stacked prompt, CLI agents as rows with switches", () => {
  setLocale("en", { reload: false });
  const document = render(
    <SpaceAgentSection
      agents={agents}
      enabledClis={["claude"]}
      defaultModel="sonnet"
      systemPrompt=""
      availableModels={[
        { id: "sonnet", name: "Sonnet", description: "Balanced" },
      ]}
      healthReport={{ restored: 0 } as never}
      refreshing={false}
      onDefaultModelChange={noop}
      onSystemPromptChange={noop}
      onSystemPromptBlur={noop}
      onCliToggle={noop}
      onRefresh={noop}
    />,
  );
  expect(groupTitles(document)).toEqual(["Chat", "CLI Agents"]);
  expectOneCardPerGroup(document);
  const [chat, clis] = Array.from(document.querySelectorAll("body > section"));
  expect(chat.querySelector('[data-slot="select-trigger"]')?.textContent).toBe(
    "Sonnet",
  );
  expect(
    chat
      .querySelector("textarea")
      ?.closest('[data-slot="field"]')
      ?.getAttribute("data-orientation"),
  ).toBe("vertical");
  expect(clis.textContent?.includes("Instruction links are OK")).toBe(true);
  const switches = Array.from(clis.querySelectorAll('[role="switch"]'));
  expect(switches.map((node) => node.getAttribute("aria-label"))).toEqual([
    "Use Claude Code in this project",
    "Use Codex in this project",
  ]);
  expect(switches.map((node) => node.getAttribute("aria-checked"))).toEqual([
    "true",
    "false",
  ]);
  expect(switches[1].hasAttribute("disabled")).toBe(true);
  expect(
    clis.querySelector('a[href="https://example.test/codex"]') !== null,
  ).toBe(true);
});

test("Defaults: one group with the model select and prompt", () => {
  setLocale("en", { reload: false });
  const document = render(
    <SpaceDefaultsSection
      model=""
      prompt=""
      availableModels={[]}
      onModelChange={noop}
      onPromptChange={noop}
      onPromptBlur={noop}
    />,
  );
  expect(groupTitles(document)).toEqual(["Agent in spaces"]);
  expectOneCardPerGroup(document);
  expect(
    document.body.textContent?.includes("Applies to the project's spaces."),
  ).toBe(true);
});

test("Instructions: AGENTS.md row with open and preview, or an empty card that creates it", () => {
  setLocale("en", { reload: false });
  const present = render(
    <SpaceInstructionsSection
      agentsMdContent={"# Agents\nBe brief"}
      enabledClis={["claude"]}
      onOpenAgentsMd={noop}
    />,
  );
  expectOneCardPerGroup(present);
  expect(present.querySelector('[data-slot="item-title"]')?.textContent).toBe(
    "AGENTS.md → CLAUDE.md",
  );
  expect(
    Array.from(present.querySelectorAll("button")).map(
      (button) => button.textContent,
    ),
  ).toEqual(["Show", "Open"]);

  const missing = render(
    <SpaceInstructionsSection
      agentsMdContent={null}
      enabledClis={[]}
      onOpenAgentsMd={noop}
    />,
  );
  expect(
    missing.querySelector('[data-slot="card"] [data-slot="empty"]')
      ?.textContent,
  ).toBe("No agent instructions yetCreate AGENTS.md");
});
