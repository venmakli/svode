import type { ReactNode } from "react";
import type { Page } from "@/features/page";
import type { ScopeOwnerRef } from "./types";

export interface ScopePeekContext {
  path: string;
  directory?: boolean;
  spaceId: string;
  spacePath: string;
  projectPath: string;
  sessionKey: string;
  fallbackTitle?: string;
  fallbackIcon?: string | null;
  metadataBefore?: ReactNode;
  renderHeaderActions?: (page: Page, readOnly: boolean) => ReactNode;
  renderActions: (
    openFullPage: () => Promise<boolean>,
    owner: ScopeOwnerRef | null,
  ) => ReactNode;
  registerNavigationGuard: (guard: () => Promise<boolean>) => () => void;
  onContentPathChange?: (path: string) => void;
}

export type ScopePeekRenderer = (context: ScopePeekContext) => ReactNode;
