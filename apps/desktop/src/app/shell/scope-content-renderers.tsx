import type { ReactNode } from "react";
import { appOwnerFromScopeOwner } from "@/features/apps";
import {
  attachmentOwnerFromScopeOwner,
  AttachmentsSurface,
} from "@/features/attachments";
import type { ScopeSurfaceContribution } from "@/features/scope-surfaces";
import { AppWithVariables } from "./app-with-variables";

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
        />
      </>
    ),
  };
}
