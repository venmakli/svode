import { createContext, useContext, useMemo, type ReactNode } from "react";

export interface PageAttachmentsSurfaceInput {
  contentPath: string;
  ownerPath: string;
  projectPath: string;
  readOnly: boolean;
  spaceId: string;
  spacePath: string;
}

export interface PageAppSurfaceInput {
  ownerPath: string;
  projectPath: string;
  spaceId: string;
  spacePath: string;
}

interface PageOwnerSurfaceContribution {
  renderAttachments(input: PageAttachmentsSurfaceInput): ReactNode;
  hasApp?: boolean;
  renderApp?(input: PageAppSurfaceInput): ReactNode;
}

const PageOwnerSurfaceContext =
  createContext<PageOwnerSurfaceContribution | null>(null);

export function PageOwnerSurfaceProvider({
  children,
  hasApp,
  renderApp,
  renderAttachments,
}: {
  children: ReactNode;
  hasApp?: boolean;
  renderApp?(input: PageAppSurfaceInput): ReactNode;
  renderAttachments(input: PageAttachmentsSurfaceInput): ReactNode;
}) {
  const value = useMemo(
    () => ({ hasApp, renderApp, renderAttachments }),
    [hasApp, renderApp, renderAttachments],
  );
  return (
    <PageOwnerSurfaceContext.Provider value={value}>
      {children}
    </PageOwnerSurfaceContext.Provider>
  );
}

export function usePageOwnerSurfaceContribution() {
  return useContext(PageOwnerSurfaceContext);
}
