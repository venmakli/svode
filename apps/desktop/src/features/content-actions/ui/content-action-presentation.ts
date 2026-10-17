import {
  Copy,
  Database,
  FilePlus,
  FileSymlink,
  FileText,
  FolderPlus,
  PanelRightOpen,
  Pencil,
  Save,
  SquarePen,
  SquareTerminal,
  Star,
  StarOff,
  Trash2,
  type LucideIcon,
} from "lucide-react";
import * as m from "@/paraglide/messages.js";
import type { ContentActionId } from "../model/catalog";

export interface ContentActionPresentation {
  label: () => string;
  icon: LucideIcon;
  destructive?: boolean;
}

/** The one label and icon of each action, on every surface. */
export const CONTENT_ACTION_PRESENTATION: Record<
  Exclude<ContentActionId, "pin">,
  ContentActionPresentation
> = {
  "open-in-peek": {
    label: () => m.collection_open_in_peek(),
    icon: PanelRightOpen,
  },
  "set-template-default": {
    label: () => m.collection_template_set_default(),
    icon: Star,
  },
  "unset-template-default": {
    label: () => m.collection_template_unset_default(),
    icon: StarOff,
  },
  "nest-page": { label: () => m.space_nest_page(), icon: FilePlus },
  "new-item": { label: () => m.content_action_new_item(), icon: FilePlus },
  "new-page": { label: () => m.space_new_page(), icon: FilePlus },
  "new-folder": { label: () => m.space_new_folder(), icon: FolderPlus },
  "new-collection": { label: () => m.collection_new(), icon: Database },
  "new-session": { label: () => m.sessions_action_new(), icon: SquarePen },
  "new-terminal": {
    label: () => m.terminal_new_terminal(),
    icon: SquareTerminal,
  },
  "make-page": { label: () => m.space_make_page(), icon: FileSymlink },
  "make-collection": { label: () => m.collection_make(), icon: Database },
  "make-leaf": { label: () => m.page_convert_to_leaf(), icon: FileText },
  "save-all": { label: () => m.git_save_all(), icon: Save },
  rename: { label: () => m.space_rename(), icon: Pencil },
  duplicate: { label: () => m.page_duplicate(), icon: Copy },
  "duplicate-template": {
    label: () => m.collection_template_duplicate(),
    icon: Copy,
  },
  delete: {
    label: () => m.content_action_delete(),
    icon: Trash2,
    destructive: true,
  },
  "remove-space": {
    label: () => m.space_delete(),
    icon: Trash2,
    destructive: true,
  },
};
