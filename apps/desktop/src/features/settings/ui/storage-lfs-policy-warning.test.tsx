import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { setLocale } from "@/paraglide/runtime";
import type { LfsPolicyDiagnostic } from "../api";
import { StorageLfsPolicyWarning } from "./storage-lfs-policy-warning";

function render(
  lfsDeclaration: LfsPolicyDiagnostic["lfsDeclaration"],
  overrides: Partial<LfsPolicyDiagnostic> = {},
) {
  return renderToStaticMarkup(
    <StorageLfsPolicyWarning
      diagnostic={{
        managedPolicyCurrent: true,
        uncoveredPaths: [],
        truncatedCount: 0,
        lfsDeclaration,
        ...overrides,
      }}
      loading={false}
      error={false}
      updating={false}
      canUpdate
      onUpdate={() => {}}
      onRefresh={() => {}}
    />,
  );
}

test("healthy non-S3 policy renders nothing", () => {
  expect(render(null)).toBe("");
});

test("declaration state is one status line without an alert", () => {
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
    expect(html.includes('role="alert"')).toBe(false);
    expect(html.includes("Update LFS policy")).toBe(false);
  }

  setLocale("ru", { reload: false });
  expect(
    render("published").includes(
      "Декларация LFS в репозитории (.lfsconfig): опубликована",
    ),
  ).toBe(true);
  setLocale("en", { reload: false });
});

test("missing declaration offers the existing policy update action", () => {
  setLocale("en", { reload: false });
  const html = render("missing");
  expect(html.includes("Repository LFS declaration is missing")).toBe(true);
  expect(html.includes("Update LFS policy")).toBe(true);
  expect(html.includes("(.lfsconfig): ")).toBe(false);

  setLocale("ru", { reload: false });
  const ru = render("missing");
  expect(ru.includes("В репозитории нет декларации LFS")).toBe(true);
  expect(ru.includes("Обновить LFS-политику")).toBe(true);
  setLocale("en", { reload: false });
});

test("stale policy keeps its alert and still shows the declaration line", () => {
  setLocale("en", { reload: false });
  const html = render("published", { managedPolicyCurrent: false });
  expect(html.includes("Repository LFS policy needs an update")).toBe(true);
  expect(
    html.includes("Repository LFS declaration (.lfsconfig): published"),
  ).toBe(true);
});
