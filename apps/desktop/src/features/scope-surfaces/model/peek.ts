import type { ReactNode } from "react";
import type { Page } from "@/features/page";

/** How the user leaves a Peek; another navigation away from it names none. */
export type PeekLeaveAction = "close" | "expand";

/** Settles the Peek content before it is left; false keeps the Peek open. */
export type PeekNavigationGuard = (
  action?: PeekLeaveAction,
) => Promise<boolean>;

export interface ScopePeekContext {
  path: string;
  spaceId: string;
  spacePath: string;
  projectPath: string;
  sessionKey: string;
  fallbackTitle?: string;
  fallbackIcon?: string | null;
  metadataBefore?: ReactNode;
  renderHeaderActions?: (page: Page, readOnly: boolean) => ReactNode;
  /** Expand: leaves the Peek through its guard, then `openFullPage`. */
  onExpand: (openFullPage: () => Promise<boolean>) => void;
  /** ×: closes the Peek through its leave guard. */
  onClose: () => void;
  registerNavigationGuard: (guard: PeekNavigationGuard) => () => void;
  onContentPathChange?: (path: string) => void;
  /** Closes the Peek at once, without its leave guard: the target is gone. */
  dismiss: () => void;
}

export type ScopePeekRenderer = (context: ScopePeekContext) => ReactNode;
