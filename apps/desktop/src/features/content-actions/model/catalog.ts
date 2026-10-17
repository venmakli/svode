import * as m from "@/paraglide/messages.js";

/** A Page is either one Markdown file or a folder with its README. */
export type PageForm = "leaf" | "folder";

/** What a folder-form Page holds besides its README. */
export interface PageFolderContents {
  subpageCount: number;
  otherFileCount: number;
}

/** The object an action menu acts on, as the menu distinguishes it. */
export type ContentObject =
  | {
      kind: "page" | "collection-item";
      form: PageForm;
      /** Unknown until read; a folder Page then stays convertible. */
      contents?: PageFolderContents | null;
    }
  | {
      kind: "template";
      form: PageForm;
      contents?: PageFolderContents | null;
      isDefault: boolean;
    }
  | { kind: "folder" }
  | { kind: "collection" }
  | { kind: "app" }
  | { kind: "space"; unsavedChanges: boolean }
  | { kind: "project-root" };

export type ContentActionId =
  | "open-in-peek"
  | "pin"
  | "set-template-default"
  | "unset-template-default"
  | "nest-page"
  | "new-item"
  | "new-page"
  | "new-folder"
  | "new-collection"
  | "new-session"
  | "new-terminal"
  | "make-page"
  | "make-collection"
  | "make-leaf"
  | "save-all"
  | "rename"
  | "duplicate"
  | "duplicate-template"
  | "delete"
  | "remove-space";

/** Menu groups in menu order; a group without actions is not shown. */
export type ContentActionGroupId =
  | "open"
  | "navigation"
  | "create"
  | "launch"
  | "convert"
  | "edit"
  | "delete";

export interface ContentAction {
  id: ContentActionId;
  disabled: boolean;
  /** Why a rule makes the action unavailable now. */
  reason: string | null;
}

export interface ContentActionGroup {
  id: ContentActionGroupId;
  actions: ContentAction[];
}

/** Actions a single surface adds to the object's menu. */
export interface ContentSurfaceActions {
  /** A Collection row opens its item in peek. */
  openInPeek?: boolean;
  /** Sidebar rows of a Space and of the project root. */
  newSession?: boolean;
  newTerminal?: boolean;
}

export interface ContentActionMenuInput {
  object: ContentObject;
  readOnly?: boolean;
  surfaceActions?: ContentSurfaceActions;
}

/** Actions that leave the content and the repository as they are. */
const NON_MUTATING_ACTIONS: ReadonlySet<ContentActionId> = new Set([
  "open-in-peek",
  "pin",
  "new-session",
  "new-terminal",
]);

const GROUP_ORDER: readonly ContentActionGroupId[] = [
  "open",
  "navigation",
  "create",
  "launch",
  "convert",
  "edit",
  "delete",
];

type GroupedActionIds = Partial<
  Record<ContentActionGroupId, ContentActionId[]>
>;

function pageActionIds(
  object: Extract<ContentObject, { form: PageForm }>,
): GroupedActionIds {
  const template = object.kind === "template";
  return {
    navigation: template
      ? [object.isDefault ? "unset-template-default" : "set-template-default"]
      : ["pin"],
    create: ["nest-page", "new-folder"],
    convert:
      object.form === "folder"
        ? ["make-collection", "make-leaf"]
        : ["make-collection"],
    edit: ["rename", template ? "duplicate-template" : "duplicate"],
    delete: ["delete"],
  };
}

function objectActionIds(object: ContentObject): GroupedActionIds {
  switch (object.kind) {
    case "page":
    case "collection-item":
    case "template":
      return pageActionIds(object);
    case "folder":
      return {
        create: ["nest-page", "new-folder"],
        convert: ["make-page", "make-collection"],
        edit: ["rename"],
        delete: ["delete"],
      };
    case "collection":
      return {
        navigation: ["pin"],
        create: ["new-item"],
        edit: ["rename"],
        delete: ["delete"],
      };
    case "app":
      return {
        navigation: ["pin"],
        edit: ["rename"],
        delete: ["delete"],
      };
    case "space":
      return {
        navigation: ["pin"],
        create: ["new-page", "new-folder", "new-collection"],
        edit: object.unsavedChanges ? ["save-all", "rename"] : ["rename"],
        delete: ["remove-space"],
      };
    case "project-root":
      return {
        navigation: ["pin"],
        create: ["new-page", "new-folder", "new-collection"],
      };
  }
}

function surfaceActionIds(
  surfaceActions: ContentSurfaceActions | undefined,
): GroupedActionIds {
  const launch: ContentActionId[] = [];
  if (surfaceActions?.newSession) launch.push("new-session");
  if (surfaceActions?.newTerminal) launch.push("new-terminal");
  return {
    open: surfaceActions?.openInPeek ? ["open-in-peek"] : [],
    launch,
  };
}

function ruleReason(id: ContentActionId, object: ContentObject): string | null {
  if (id !== "make-leaf" || !("contents" in object) || !object.contents) {
    return null;
  }
  const { subpageCount, otherFileCount } = object.contents;
  if (subpageCount === 0 && otherFileCount === 0) return null;
  return m.page_convert_leaf_blocked({
    subpages: subpageCount,
    files: otherFileCount,
  });
}

/**
 * The action menu of an object: its groups and their actions in menu order.
 * Every surface builds the object's menu from this and adds only its own
 * surface actions; read-only keeps mutating actions visible but unavailable.
 */
export function contentActionGroups({
  object,
  readOnly = false,
  surfaceActions,
}: ContentActionMenuInput): ContentActionGroup[] {
  const objectIds = objectActionIds(object);
  const surfaceIds = surfaceActionIds(surfaceActions);
  return GROUP_ORDER.flatMap((groupId) => {
    const ids = [...(surfaceIds[groupId] ?? []), ...(objectIds[groupId] ?? [])];
    if (ids.length === 0) return [];
    const actions = ids.map((id): ContentAction => {
      const reason = ruleReason(id, object);
      return {
        id,
        disabled:
          reason !== null || (readOnly && !NON_MUTATING_ACTIONS.has(id)),
        reason,
      };
    });
    return [{ id: groupId, actions }];
  });
}
