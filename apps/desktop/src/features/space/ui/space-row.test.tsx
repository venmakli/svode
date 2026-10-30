import { expect, test } from "bun:test";
import { DndContext } from "@dnd-kit/core";
import { SortableContext } from "@dnd-kit/sortable";
import { createRef, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SidebarProvider } from "@/components/ui/sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";
import * as m from "@/paraglide/messages.js";
import { SpaceRow } from "./space-row";

const noop = () => {};

const props: ComponentProps<typeof SpaceRow> = {
  ws: {
    id: "space-row-drag-test",
    name: "Space",
    icon: "S",
    description: "",
    path: "/__space-row-drag-test__/space",
    hasSpaces: false,
    hasSchema: false,
    lastOpened: null,
    status: "ready",
    lfsState: "n/a",
  },
  isActive: false,
  tree: [
    {
      name: "doc.md",
      path: "doc.md",
      title: "Page",
      icon: null,
      has_changes: false,
      has_schema: false,
      children: [],
    },
  ],
  editingSpaceId: null,
  editValue: "",
  activeRevealKey: null,
  setEditValue: noop,
  setEditingSpaceId: noop,
  handleRenameSpace: noop,
  handleNewPage: noop,
  handleNewFolder: noop,
  handleNewCollection: noop,
  openScopeHome: noop,
  setDeleteTarget: noop,
  handleCloneMissing: noop,
  handleRemoveBroken: noop,
  ensureTreeLoaded: async () => {},
  scopeState: {
    manuallyCollapsedRevealKey: null,
    manuallyOpened: true,
  },
  loadTreeChildren: async () => {},
  onScopeStateChange: noop,
  onActivateContent: noop,
  onBeforeNavigation: async () => true,
  editRef: createRef<HTMLInputElement>(),
  rootPath: "/__space-row-drag-test__",
  loading: false,
  refreshing: false,
  treeLoaded: true,
};

test("uses the complete resource row as the drag source outside the Space activator", () => {
  const html = renderToStaticMarkup(
    <SidebarProvider>
      <DndContext>
        <SortableContext items={[props.ws.id]}>
          <SpaceRow {...props} />
        </SortableContext>
      </DndContext>
    </SidebarProvider>,
  );

  const itemTag = html.match(/<li[^>]*data-sidebar="menu-item"[^>]*>/)?.[0];
  const activatorTag = html.match(
    /<button[^>]*data-space-drag-activator="true"[^>]*>/,
  )?.[0];
  const resourceTag = html.match(
    /<a[^>]*data-svode-resource-drag-source="true"[^>]*>/,
  )?.[0];

  if (!itemTag || !activatorTag || !resourceTag) {
    throw new Error(
      "Expected Space sortable item, header activator, and resource drag row",
    );
  }

  expect(itemTag.includes('role="button"')).toBe(false);
  expect(itemTag.includes('tabindex="0"')).toBe(false);
  expect(activatorTag.includes('role="button"')).toBe(true);
  expect(activatorTag.includes('tabindex="0"')).toBe(true);
  expect(activatorTag.includes('aria-roledescription="sortable"')).toBe(true);
  expect(resourceTag.includes('data-sidebar="menu-sub-button"')).toBe(true);
  expect(resourceTag.includes('draggable="true"')).toBe(true);
  expect(resourceTag.includes("flex-1")).toBe(true);
  expect(resourceTag.includes("cursor-pointer")).toBe(true);
  expect(resourceTag.includes("active:cursor-grabbing")).toBe(true);
  expect(/<span[^>]*data-svode-resource-drag-source/.test(html)).toBe(false);

  const activatorStart = html.indexOf("data-space-drag-activator");
  const activatorEnd = html.indexOf("</button>", activatorStart);
  const resourceStart = html.indexOf("data-svode-resource-drag-source");

  expect(activatorStart > -1).toBe(true);
  expect(activatorEnd > activatorStart).toBe(true);
  expect(resourceStart > activatorEnd).toBe(true);
});

test("a space whose config cannot be read stays openable with a warning instead of broken actions", () => {
  const render = (ws: ComponentProps<typeof SpaceRow>["ws"]) =>
    renderToStaticMarkup(
      <TooltipProvider>
        <SidebarProvider>
          <DndContext>
            <SortableContext items={[ws.id]}>
              <SpaceRow {...props} ws={ws} />
            </SortableContext>
          </DndContext>
        </SidebarProvider>
      </TooltipProvider>,
    );
  const label = m.space_config_unreadable_space_title();

  const unreadable = render({
    ...props.ws,
    name: "docs",
    configUnreadable: { kind: "conflict" },
  });
  expect(unreadable.includes(`aria-label="${label}"`)).toBe(true);
  // The ready row: its activator opens the space, not the dimmed broken row.
  expect(unreadable.includes("data-space-drag-activator")).toBe(true);
  expect(unreadable.includes('aria-disabled="false"')).toBe(true);
  expect(unreadable.includes('data-slot="collapsible-content"')).toBe(true);

  expect(render(props.ws).includes(`aria-label="${label}"`)).toBe(false);
});
