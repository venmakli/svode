import { lazy, Suspense, type ReactNode } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { appOwnerFromScopeOwner } from "@/features/apps";
import {
  attachmentOwnerFromScopeOwner,
  AttachmentsSurface,
} from "@/features/attachments";
import type { ScopeSurfaceContribution } from "@/features/scope-surfaces";
import { AppWithVariables } from "./app-with-variables";

const AttachmentOwnerPeek = lazy(async () => {
  const module = await import("./attachment-owner-peek");
  return { default: module.AttachmentOwnerPeek };
});

export function createScopeContentRenderers({
  readOnly,
  name,
  recovery,
}: {
  readOnly: boolean;
  name?: string;
  recovery?: ReactNode;
}): Record<"app" | "attachments", ScopeSurfaceContribution["render"]> {
  return {
    app: ({ owner }) => (
      <AppWithVariables owner={appOwnerFromScopeOwner(owner)} name={name} />
    ),
    attachments: ({ owner }) => (
      <>
        {recovery}
        <AttachmentsSurface
          owner={attachmentOwnerFromScopeOwner(owner)}
          readOnly={readOnly}
          renderOwnerPeek={(context) => (
            <Suspense fallback={<Skeleton className="m-6 h-48" />}>
              <AttachmentOwnerPeek
                key={context.target.ownerSession?.key ?? context.target.row.key}
                {...context}
              />
            </Suspense>
          )}
        />
      </>
    ),
  };
}
