import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ThemeProvider } from "@/components/ui/theme-provider";
import * as m from "@/paraglide/messages.js";
import { PageIdentityHeader } from "./page-identity-header";

test("places the coverless picker before the page actions without reserving banner space", () => {
  const markup = renderToStaticMarkup(
    <ThemeProvider theme="light" setTheme={() => undefined}>
      <PageIdentityHeader
        title="Svode"
        icon={null}
        description=""
        cover={null}
        projectPath={null}
        spacePath="/project"
        pagePath="readme.md"
        onTitleChange={() => undefined}
        onIconChange={() => undefined}
        onDescriptionChange={() => undefined}
        onCoverChange={() => undefined}
        onBodyFocus={() => undefined}
        actions={<button data-page-actions>Actions</button>}
      />
    </ThemeProvider>,
  );

  const coverPickerIndex = markup.indexOf(m.editor_add_cover());
  const pageActionsIndex = markup.indexOf("data-page-actions");

  expect(coverPickerIndex > -1).toBe(true);
  expect(coverPickerIndex < pageActionsIndex).toBe(true);
  expect(markup.includes("group h-12")).toBe(false);
  expect(markup.includes("h-10 w-full justify-center")).toBe(false);
});

test("keeps the covered Page action before page actions and hides it when read-only", () => {
  const render = (readOnly: boolean) =>
    renderToStaticMarkup(
      <ThemeProvider theme="light" setTheme={() => undefined}>
        <PageIdentityHeader
          title="Svode"
          icon={null}
          description=""
          cover={{ type: "color", value: "blue" }}
          projectPath={null}
          spacePath="/project"
          pagePath="readme.md"
          onTitleChange={() => undefined}
          onIconChange={() => undefined}
          onDescriptionChange={() => undefined}
          onCoverChange={() => undefined}
          onBodyFocus={() => undefined}
          readOnly={readOnly}
          actions={<button data-page-actions>Actions</button>}
        />
      </ThemeProvider>,
    );

  const editMarkup = render(false);
  expect(editMarkup.indexOf(m.editor_change_cover()) > -1).toBe(true);
  expect(
    editMarkup.indexOf(m.editor_change_cover()) <
      editMarkup.indexOf("data-page-actions"),
  ).toBe(true);
  expect(render(true).includes(m.editor_change_cover())).toBe(false);
});
