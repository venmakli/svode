import type { ReactNode } from "react";
import type { Page } from "@/features/page";
import type { ScopeOwnerRef } from "./types";

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
  /** The Changes control of the resolved owner in the Peek top bar. */
  renderChanges?: (owner: ScopeOwnerRef) => ReactNode;
  registerNavigationGuard: (guard: () => Promise<boolean>) => () => void;
  onContentPathChange?: (path: string) => void;
  /** Closes the Peek at once, without its leave guard: the target is gone. */
  dismiss: () => void;
}

export type ScopePeekRenderer = (context: ScopePeekContext) => ReactNode;
