import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { EntryDetailProvider } from "../hooks/entry-detail-context";
import { ReadmeSurface } from "./readme-surface";
import { ScopeOwnerHeader } from "./scope-owner-header";

test("keeps fallback identity hidden while the owner README is loading", () => {
  const markup = renderToStaticMarkup(
    <EntryDetailProvider
      spacePath="/repo"
      projectPath="/repo"
      spaceId="root"
      readmePath="README.md"
      ownerPath="."
      fallbackTitle="Project title"
      fallbackIcon="🚀"
      onOpenPath={() => undefined}
    >
      <ScopeOwnerHeader />
      <ReadmeSurface />
    </EntryDetailProvider>,
  );

  expect(markup.includes("Project title")).toBe(false);
  expect(markup.includes("🚀")).toBe(false);
  expect(markup.match(/data-slot="skeleton"/g)?.length).toBe(13);
  expect(markup.includes("h-44 min-h-32 max-h-48")).toBe(true);
  expect(markup.includes("min-h-[320px]")).toBe(true);
});
