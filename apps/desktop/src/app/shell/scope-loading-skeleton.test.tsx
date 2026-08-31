import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  PageDetailProvider,
  PageSurfaceSessionProvider,
  ReadmeSurface,
} from "@/features/page/scope-surface";
import { ScopeOwnerHeader } from "@/features/scope-surfaces";

test("keeps fallback identity hidden while the owner README is loading", () => {
  const markup = renderToStaticMarkup(
    <PageSurfaceSessionProvider
      displayName="Project title"
      displayPath="README.md"
      spacePath="/repo"
      targetKey="root"
    >
      <PageDetailProvider
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
      </PageDetailProvider>
    </PageSurfaceSessionProvider>,
  );

  expect(markup.includes("Project title")).toBe(false);
  expect(markup.includes("🚀")).toBe(false);
  expect(markup.match(/data-slot="skeleton"/g)?.length).toBe(13);
  expect(markup.includes("h-44 min-h-32 max-h-48")).toBe(true);
  expect(markup.includes("min-h-[320px]")).toBe(true);
});
