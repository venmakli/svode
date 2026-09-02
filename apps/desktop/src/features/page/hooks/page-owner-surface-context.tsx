import { createContext, useContext, useMemo, type ReactNode } from "react";

export interface PageAttachmentsSurfaceInput {
  contentPath: string;
  ownerPath: string;
  projectPath: string;
  readOnly: boolean;
  spaceId: string;
  spacePath: string;
}

interface PageOwnerSurfaceContribution {
  renderAttachments(input: PageAttachmentsSurfaceInput): ReactNode;
}

const PageOwnerSurfaceContext =
  createContext<PageOwnerSurfaceContribution | null>(null);

export function PageOwnerSurfaceProvider({
  children,
  renderAttachments,
}: {
  children: ReactNode;
  renderAttachments(input: PageAttachmentsSurfaceInput): ReactNode;
}) {
  const value = useMemo(() => ({ renderAttachments }), [renderAttachments]);
  return (
    <PageOwnerSurfaceContext.Provider value={value}>
      {children}
    </PageOwnerSurfaceContext.Provider>
  );
}

export function usePageOwnerSurfaceContribution() {
  return useContext(PageOwnerSurfaceContext);
}
