import * as m from "@/paraglide/messages.js";
import type { ContentObject, PageForm } from "./catalog";

/** An object the content delete dialog confirms; a Space keeps its removal. */
export type DeletableContentObject = Exclude<
  ContentObject,
  { kind: "space" | "project-root" }
>;

/** A Page that links to the object being deleted. */
export interface ContentBacklink {
  key: string;
  label: string;
}

/** An open delete confirmation and the value its confirm acts on. */
export interface ContentDeleteConfirmation<T> {
  object: DeletableContentObject;
  name: string;
  backlinks: readonly ContentBacklink[];
  value: T;
}

export interface ContentDeleteCopy {
  title: string;
  description: string;
}

/** The form of a Page at `path`: a folder Page is its folder's README. */
export function pageFormOfPath(path: string): PageForm {
  return path.toLowerCase().endsWith("/readme.md") ? "folder" : "leaf";
}

function hasNestedContent(object: DeletableContentObject): boolean {
  if (!("contents" in object) || !object.contents) return false;
  return object.contents.subpageCount + object.contents.otherFileCount > 0;
}

/** The title and description that name the object, its type and what goes. */
export function contentDeleteCopy(
  object: DeletableContentObject,
  name: string,
): ContentDeleteCopy {
  const nested = hasNestedContent(object);
  switch (object.kind) {
    case "page":
      return {
        title: m.content_delete_page_title(),
        description: nested
          ? m.content_delete_page_nested_description({ name })
          : m.content_delete_page_description({ name }),
      };
    case "collection-item":
      return {
        title: m.content_delete_item_title(),
        description: nested
          ? m.content_delete_item_nested_description({ name })
          : m.content_delete_item_description({ name }),
      };
    case "template":
      return {
        title: m.content_delete_template_title(),
        description: nested
          ? m.content_delete_template_nested_description({ name })
          : m.content_delete_template_description({ name }),
      };
    case "folder":
      return {
        title: m.content_delete_folder_title(),
        description: m.content_delete_folder_description({ name }),
      };
    case "collection":
      return {
        title: m.content_delete_collection_title(),
        description: m.content_delete_collection_description({ name }),
      };
    case "app":
      return {
        title: m.content_delete_app_title(),
        description: m.content_delete_app_description({ name }),
      };
  }
}
