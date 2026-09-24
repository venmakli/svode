import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { setLocale } from "@/paraglide/runtime";
import type { LfsPolicyDiagnostic } from "../api";
import { StorageLfsPolicyRow } from "./storage-lfs-policy-row";

function render(
  lfsDeclaration: LfsPolicyDiagnostic["lfsDeclaration"],
  overrides: Partial<LfsPolicyDiagnostic> = {},
  diagnostic = true,
) {
  return renderToStaticMarkup(
    <StorageLfsPolicyRow
      diagnostic={
        diagnostic
          ? {
              managedPolicyCurrent: true,
              uncoveredPaths: [],
              truncatedCount: 0,
              lfsDeclaration,
              ...overrides,
            }
          : null
      }
      loading={!diagnostic}
      error={false}
      updating={false}
      canUpdate
      onUpdate={() => {}}
      onRefresh={() => {}}
    />,
  );
}

test("a current policy is one row with its status and a check again", () => {
  setLocale("en", { reload: false });
  const html = render(null);
  expect(html.includes("Repository LFS policy")).toBe(true);
  expect(html.includes("Up to date")).toBe(true);
  expect(html.includes("Check again")).toBe(true);
  expect(html.includes("Needs attention")).toBe(false);
  expect(html.includes(">Update<")).toBe(false);
  expect(html.includes('role="alert"')).toBe(false);
  expect(render(null, {}, false).includes("Checking…")).toBe(true);
});

test("the declaration state is a status line without attention", () => {
  setLocale("en", { reload: false });
  for (const [state, label] of [
    ["published", "published"],
    ["pending", "waiting to be saved"],
    ["foreign", "set by the user"],
  ] as const) {
    const html = render(state);
    expect(
      html.includes(`Repository LFS declaration (.lfsconfig): ${label}`),
    ).toBe(true);
    expect(html.includes("Needs attention")).toBe(false);
    expect(html.includes(">Update<")).toBe(false);
  }

  setLocale("ru", { reload: false });
  expect(
    render("published").includes(
      "Декларация LFS в репозитории (.lfsconfig): опубликована",
    ),
  ).toBe(true);
  setLocale("en", { reload: false });
});

test("a missing declaration asks for attention and offers the policy update", () => {
  setLocale("en", { reload: false });
  const html = render("missing");
  expect(html.includes("No LFS declaration (.lfsconfig)")).toBe(true);
  expect(html.includes("Needs attention")).toBe(true);
  expect(html.includes(">Update<")).toBe(true);
  expect(html.includes("(.lfsconfig): ")).toBe(false);

  setLocale("ru", { reload: false });
  const ru = render("missing");
  expect(ru.includes("Нет декларации LFS (.lfsconfig)")).toBe(true);
  expect(ru.includes(">Обновить<")).toBe(true);
  setLocale("en", { reload: false });
});

test("a stale policy keeps its update and the declaration line", () => {
  setLocale("en", { reload: false });
  const html = render("published", { managedPolicyCurrent: false });
  expect(html.includes("Needs an update")).toBe(true);
  expect(html.includes(">Update<")).toBe(true);
  expect(
    html.includes("Repository LFS declaration (.lfsconfig): published"),
  ).toBe(true);
});

test("uncovered media lists the first paths and counts the rest", () => {
  setLocale("en", { reload: false });
  const paths = Array.from({ length: 6 }, (_, index) => `media/${index}.psd`);
  const html = render(null, { uncoveredPaths: paths, truncatedCount: 2 });
  expect(
    html.includes("8 changed media file(s) are not covered by Git LFS"),
  ).toBe(true);
  expect(html.includes("media/4.psd")).toBe(true);
  expect(html.includes("media/5.psd")).toBe(false);
  expect(html.includes("And 3 more.")).toBe(true);
  expect(html.includes(">Update<")).toBe(false);
});
