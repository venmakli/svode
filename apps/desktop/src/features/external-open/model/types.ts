import type { ReactNode } from "react";

import type { ExternalAppDto } from "@/platform/project-openers";

export type ExternalApp = ExternalAppDto;

/** Something that can be opened in an external application. */
export interface ExternalOpenTarget {
  /** Device-local preference slot shared by every target of this kind. */
  preferenceKey: string;
  listApps(): Promise<readonly ExternalApp[]>;
  /** `null` hands the choice to the OS default application. */
  open(appId: string | null): Promise<void>;
  /** Shows the target selected in the file manager; offered for files only. */
  reveal?(): Promise<void>;
}

/** A target together with the surface that reports its failures. */
export interface ExternalOpenBinding {
  target: ExternalOpenTarget;
  onError(error: unknown, app: ExternalApp | null): void;
}

/** The action of the primary button of an "Open with" control. */
export interface OpenWithAction {
  label: string;
  renderIcon(dataIcon?: "inline-start"): ReactNode;
  run(): void;
  /** Why the action cannot run now; the button is disabled with it in the tooltip. */
  disabledReason?: string | null;
}

/**
 * One group of an "Open with" control. The first group of a control gives
 * the primary button; menus show the groups in order between separators.
 */
export interface OpenWithGroup {
  primary: OpenWithAction;
  /** Menu entries: one or more `DropdownMenuGroup`s, separated inside. */
  items: ReactNode;
  /** Blocks the whole control while an action of the group runs. */
  pending: boolean;
  /** Refreshes what the group offers each time the menu opens. */
  onMenuOpen?(): void;
}
