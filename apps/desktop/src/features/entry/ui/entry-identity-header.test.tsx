import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ThemeProvider } from "@/components/ui/theme-provider";
import * as m from "@/paraglide/messages.js";
import { EntryIdentityHeader } from "./entry-identity-header";

test("places the coverless picker before the entry actions without reserving banner space", () => {
  const markup = renderToStaticMarkup(
    <ThemeProvider theme="light" setTheme={() => undefined}>
      <EntryIdentityHeader
        title="Svode"
        icon={null}
        description=""
        cover={null}
        projectPath={null}
        spacePath="/project"
        documentPath="readme.md"
        onTitleChange={() => undefined}
        onIconChange={() => undefined}
        onDescriptionChange={() => undefined}
        onCoverChange={() => undefined}
        onBodyFocus={() => undefined}
        actions={<button data-entry-actions>Actions</button>}
      />
    </ThemeProvider>,
  );

  const coverPickerIndex = markup.indexOf(m.editor_add_cover());
  const entryActionsIndex = markup.indexOf("data-entry-actions");

  expect(coverPickerIndex > -1).toBe(true);
  expect(coverPickerIndex < entryActionsIndex).toBe(true);
  expect(markup.includes("group h-12")).toBe(false);
  expect(markup.includes("h-10 w-full justify-center")).toBe(false);
});
