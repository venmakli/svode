import { useMemo, useState, type ReactNode } from "react";
import { resolveScopeSurfaceContributions } from "../model/registry";
import { resolveActiveScopeSurface } from "../model/active-surface";
import type {
  ScopeOwnerRef,
  ScopePresentation,
  ScopeSurfaceContribution,
  ScopeSurfaceId,
} from "../model/types";
import { ScopeSurfaceErrorBoundary } from "./scope-surface-error-boundary";
import { ScopeSurfaceTabs } from "./scope-surface-tabs";

interface ScopeSurfaceHostProps {
  owner: ScopeOwnerRef;
  presentation: ScopePresentation;
  contributions: readonly ScopeSurfaceContribution[];
  header: ReactNode;
  initialSurfaceId?: ScopeSurfaceId;
}

export function ScopeSurfaceHost({
  owner,
  presentation,
  contributions,
  header,
  initialSurfaceId,
}: ScopeSurfaceHostProps) {
  const surfaces = useMemo(
    () => resolveScopeSurfaceContributions(contributions, owner, presentation),
    [contributions, owner, presentation],
  );
  const [requestedSurfaceId, setRequestedSurfaceId] = useState<
    ScopeSurfaceId | undefined
  >(initialSurfaceId);
  const activeSurface = resolveActiveScopeSurface(surfaces, requestedSurfaceId);

  if (!activeSurface) return <>{header}</>;

  return (
    <div className="flex min-h-full flex-col">
      {header}
      <ScopeSurfaceTabs
        surfaces={surfaces}
        value={activeSurface.id}
        onValueChange={setRequestedSurfaceId}
      >
        <ScopeSurfaceErrorBoundary
          key={`${owner.ownerKey}:${activeSurface.id}`}
        >
          {activeSurface.render({ owner, presentation })}
        </ScopeSurfaceErrorBoundary>
      </ScopeSurfaceTabs>
    </div>
  );
}
