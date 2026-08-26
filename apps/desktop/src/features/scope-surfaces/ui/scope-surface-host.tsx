import { useEffect, useMemo, type ReactNode } from "react";
import { resolveScopeSurfaceContributions } from "../model/registry";
import {
  resolveActiveScopeSurface,
  resolveDefaultScopeSurface,
} from "../model/active-surface";
import { useScopeSurfaceStore } from "../model/surface-store";
import type {
  ScopeOpenIntent,
  ScopeOwnerRef,
  ScopePresentation,
  ScopeSurfaceContribution,
  ScopeSurfaceId,
} from "../model/types";
import { ScopeSurfaceErrorBoundary } from "./scope-surface-error-boundary";
import { ScopeSurfaceTabs } from "./scope-surface-tabs";
import { useOptionalSystemCollectionDetailController } from "@/features/collection/system";

interface ScopeSurfaceHostProps {
  owner: ScopeOwnerRef;
  presentation: ScopePresentation;
  contributions: readonly ScopeSurfaceContribution[];
  header: ReactNode;
  openIntent?: ScopeOpenIntent;
  openRequestKey?: number;
  previousOwnerKey?: ScopeOwnerRef["ownerKey"];
  sessionKey?: string | number;
  compactSurfaceId?: ScopeSurfaceId;
  onCompactSurfaceIdChange?: (surfaceId: ScopeSurfaceId) => void;
}

export function ScopeSurfaceHost({
  owner,
  presentation,
  contributions,
  header,
  openIntent,
  openRequestKey,
  previousOwnerKey,
  sessionKey,
  compactSurfaceId,
  onCompactSurfaceIdChange,
}: ScopeSurfaceHostProps) {
  const surfaces = useMemo(
    () => resolveScopeSurfaceContributions(contributions, owner, presentation),
    [contributions, owner, presentation],
  );
  const systemCollectionDetailController =
    useOptionalSystemCollectionDetailController();
  const storedSurfaceId = useScopeSurfaceStore(
    (state) => state.surfaceByOwnerKey[owner.ownerKey],
  );
  const previousStoredSurfaceId = useScopeSurfaceStore((state) =>
    previousOwnerKey ? state.surfaceByOwnerKey[previousOwnerKey] : undefined,
  );
  const appliedOpenRequestKey = useScopeSurfaceStore(
    (state) => state.openRequestKeyByOwnerKey[owner.ownerKey],
  );
  const previousAppliedOpenRequestKey = useScopeSurfaceStore((state) =>
    previousOwnerKey
      ? state.openRequestKeyByOwnerKey[previousOwnerKey]
      : undefined,
  );
  const setStoredSurface = useScopeSurfaceStore((state) => state.setSurface);
  const applyOpenRequest = useScopeSurfaceStore(
    (state) => state.applyOpenRequest,
  );
  const retargetOwner = useScopeSurfaceStore((state) => state.retargetOwner);
  const effectiveStoredSurfaceId = storedSurfaceId ?? previousStoredSurfaceId;
  const effectiveAppliedOpenRequestKey =
    appliedOpenRequestKey ?? previousAppliedOpenRequestKey;
  const defaultSurfaceId = resolveDefaultScopeSurface(owner);
  const hasPendingOpenRequest =
    presentation === "full" &&
    openRequestKey !== undefined &&
    openRequestKey !== effectiveAppliedOpenRequestKey;
  const intentSurfaceId =
    openIntent?.kind === "target" ? openIntent.surfaceId : defaultSurfaceId;
  const requestedSurfaceId =
    presentation === "full"
      ? hasPendingOpenRequest
        ? intentSurfaceId
        : (effectiveStoredSurfaceId ?? defaultSurfaceId)
      : compactSurfaceId;
  const fallbackSurfaceId =
    presentation === "full" ? defaultSurfaceId : "readme";
  const activeSurface = resolveActiveScopeSurface(
    surfaces,
    requestedSurfaceId,
    fallbackSurfaceId,
  );

  useEffect(() => {
    if (!previousOwnerKey || previousOwnerKey === owner.ownerKey) return;
    retargetOwner(previousOwnerKey, owner.ownerKey);
  }, [owner.ownerKey, previousOwnerKey, retargetOwner]);

  useEffect(() => {
    if (
      presentation !== "full" ||
      openRequestKey === undefined ||
      !hasPendingOpenRequest ||
      !activeSurface
    ) {
      return;
    }
    applyOpenRequest(owner.ownerKey, openRequestKey, activeSurface.id);
  }, [
    activeSurface,
    applyOpenRequest,
    hasPendingOpenRequest,
    openRequestKey,
    owner.ownerKey,
    presentation,
  ]);

  useEffect(() => {
    if (
      presentation === "full" &&
      activeSurface &&
      !hasPendingOpenRequest &&
      effectiveStoredSurfaceId !== activeSurface.id
    ) {
      setStoredSurface(owner.ownerKey, activeSurface.id);
    }
  }, [
    activeSurface,
    hasPendingOpenRequest,
    owner.ownerKey,
    presentation,
    setStoredSurface,
    effectiveStoredSurfaceId,
  ]);

  if (!activeSurface) return <>{header}</>;

  return (
    <div className="flex min-h-full flex-col">
      {header}
      <ScopeSurfaceTabs
        surfaces={surfaces}
        value={activeSurface.id}
        onValueChange={(surfaceId) => {
          void (async () => {
            if (
              systemCollectionDetailController &&
              !(await systemCollectionDetailController.prepareForNavigation())
            ) {
              return;
            }
            if (presentation === "full") {
              setStoredSurface(owner.ownerKey, surfaceId);
              return;
            }
            onCompactSurfaceIdChange?.(surfaceId);
          })();
        }}
      >
        <ScopeSurfaceErrorBoundary
          key={`${sessionKey ?? owner.ownerKey}:${activeSurface.id}`}
        >
          {activeSurface.render({ owner, presentation })}
        </ScopeSurfaceErrorBoundary>
      </ScopeSurfaceTabs>
    </div>
  );
}
