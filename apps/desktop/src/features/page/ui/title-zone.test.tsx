import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { TitleZone } from "./title-zone";

test("renders a read-only fallback emoji without mounting the editable picker", () => {
  const markup = renderToStaticMarkup(
    <TitleZone
      title="Design"
      icon={null}
      description=""
      readOnly
      hideDescription
      fallbackEmoji="🎨"
      onActivateIdentity={() => undefined}
      onTitleChange={() => undefined}
      onIconChange={() => undefined}
      onDescriptionChange={() => undefined}
      onBodyFocus={() => undefined}
    />,
  );

  expect(markup.includes("🎨")).toBe(true);
  expect(markup.includes('aria-label="Design"')).toBe(true);
});

test("omits empty icon and description affordances in read-only mode", () => {
  const markup = renderToStaticMarkup(
    <TitleZone
      title="Page"
      icon={null}
      description=""
      readOnly
      onTitleChange={() => undefined}
      onIconChange={() => undefined}
      onDescriptionChange={() => undefined}
      onBodyFocus={() => undefined}
    />,
  );

  expect(markup.includes("<button")).toBe(false);
  expect(markup.includes("<textarea")).toBe(false);
  expect(markup.includes('value="Page"')).toBe(true);
});

test("exposes an inline Page name conflict through the title field", () => {
  const markup = renderToStaticMarkup(
    <TitleZone
      title="Shared"
      icon={null}
      description=""
      fallbackEmoji="📄"
      titleError="A Page with this name already exists here (other.md)."
      onTitleChange={() => undefined}
      onIconChange={() => undefined}
      onDescriptionChange={() => undefined}
      onBodyFocus={() => undefined}
    />,
  );

  expect(markup.includes('aria-invalid="true"')).toBe(true);
  expect(markup.includes('aria-describedby="page-title-error"')).toBe(true);
  expect(markup.includes('role="alert"')).toBe(true);
  expect(markup.includes("other.md")).toBe(true);
});
