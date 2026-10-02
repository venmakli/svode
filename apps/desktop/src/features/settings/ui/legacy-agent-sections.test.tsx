import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";
import { setLocale } from "@/paraglide/runtime";
import { SpaceAgentSection } from "./space-agent-section";
import { SpaceDefaultsSection } from "./space-defaults-section";
import { SpaceInstructionsSection } from "./space-instructions-section";

const noop = () => {};

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

test("AI agent: one chat group with the model select and stacked prompt", () => {
  setLocale("en", { reload: false });
  const document = render(
    <SpaceAgentSection
      defaultModel="sonnet"
      systemPrompt=""
      availableModels={[
        { id: "sonnet", name: "Sonnet", description: "Balanced" },
      ]}
      onDefaultModelChange={noop}
      onSystemPromptChange={noop}
      onSystemPromptBlur={noop}
    />,
  );
  // Agents are switched on once for the app in Providers, not per project.
  expect(groupTitles(document)).toEqual(["Chat"]);
  expectOneCardPerGroup(document);
  const [chat] = Array.from(document.querySelectorAll("body > section"));
  expect(chat.querySelector('[data-slot="select-trigger"]')?.textContent).toBe(
    "Sonnet",
  );
  expect(
    chat
      .querySelector("textarea")
      ?.closest('[data-slot="field"]')
      ?.getAttribute("data-orientation"),
  ).toBe("vertical");
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
