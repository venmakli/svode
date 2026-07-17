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
