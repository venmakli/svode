import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SearchDialogShell } from "./search-dialog-shell";

test("uses one responsive Results Sidebar to main graph tree", () => {
  const html = renderToStaticMarkup(
    <SearchDialogShell
      sidebarLabel="Search navigation"
      commandValue=""
      onCommandValueChange={() => undefined}
      searchInput={<input aria-label="Search" />}
      scopeControls={<button type="button">Entire project</button>}
      readingContent={<div data-search-results>Recent</div>}
      status={<div data-search-status>Fresh · 2 nodes</div>}
      breadcrumb={<div data-search-breadcrumb>Entire project / Graph</div>}
      openGraphAction={<button type="button">Open Graph</button>}
      graph={<div data-knowledge-graph>Graph</div>}
      resetAction={<button type="button">Reset graph</button>}
    />,
  );

  expect(html.includes("data-search-layout")).toBe(true);
  expect(html.includes("flex-col")).toBe(true);
  expect(html.includes("lg:flex-row")).toBe(true);
  expect(html.includes("h-[46%]")).toBe(true);
  expect(html.includes("lg:w-64")).toBe(true);
  expect(
    html.indexOf("data-search-sidebar") < html.indexOf("data-search-main"),
  ).toBe(true);
  expect(count(html, "data-search-reading-scroll-owner")).toBe(1);
  expect(count(html, "data-search-canvas")).toBe(1);
  expect(count(html, "data-knowledge-graph")).toBe(1);
  expect(html.includes("min-w-0 flex-1 flex-col overflow-hidden")).toBe(true);
  expect(html.includes("max-w-full")).toBe(true);
});

test("keeps Results, status, Breadcrumb, and graph actions in their owners", () => {
  const html = renderToStaticMarkup(
    <SearchDialogShell
      sidebarLabel="Search navigation"
      commandValue="node-1"
      onCommandValueChange={() => undefined}
      searchInput={<input aria-label="Search" />}
      scopeControls={<button type="button">Filters</button>}
      readingContent={<div data-search-detail>Detail</div>}
      status={<div data-search-status>Status</div>}
      breadcrumb={<div data-search-breadcrumb>Docs / … / design.md</div>}
      openGraphAction={<button type="button">Open Graph</button>}
      graph={<div data-knowledge-graph>Graph</div>}
      resetAction={<button type="button">Reset graph</button>}
    />,
  );

  const sidebarStart = html.indexOf("data-search-sidebar");
  const mainStart = html.indexOf("data-search-main");
  expect(html.indexOf("data-search-detail") > sidebarStart).toBe(true);
  expect(html.indexOf("data-search-detail") < mainStart).toBe(true);
  expect(html.indexOf("data-search-status") < mainStart).toBe(true);
  expect(html.indexOf("data-search-breadcrumb") > mainStart).toBe(true);
  expect(html.indexOf("Open Graph") > mainStart).toBe(true);
  expect(html.indexOf("Reset graph") > html.indexOf("data-search-canvas")).toBe(
    true,
  );
});

function count(value: string, pattern: string) {
  return value.split(pattern).length - 1;
}
