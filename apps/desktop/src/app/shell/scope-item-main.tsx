import { useCallback, useEffect, useMemo, useRef } from "react";
import { BreadcrumbPage } from "@/components/ui/breadcrumb";
import {
  closeActiveContent,
  openScopeOwner,
  registerSupplementalContentDeactivation,
} from "@/features/artifact";
import {
  ExternalOpenGroupHost,
  type OpenWithGroup,
} from "@/features/external-open";
import {
  getNavigationState,
  navigationKeyId,
  publishNavigationItemDisplays,
} from "@/features/navigation";
import {
  ScopeSurfaceErrorBoundary,
  type ScopeItemRef,
  type ScopeMainItem,
  type ScopeMainItemTopBar,
  type ScopeOwnerRef,
  type ScopeSurfaceContribution,
} from "@/features/scope-surfaces";
import { useSpace } from "@/features/space";
import { SpaceBreadcrumbs } from "@/features/space/app-shell";
import { itemNavigationKey, scopeOwnerTargetOf } from "./item-navigation";
import { PublishMainHeader } from "./main-header-contribution";
import { useShellStore } from "./model";
import { passNavigationGuards } from "./navigation-guards";
import { useShellView } from "./shell-view";

/**
 * "Expand" of an item in a peek of the owner's surfaces: after the guards of
 * the peeks and the main area, the item becomes the main area object over
 * its owner, and the peek closes with the surface it belongs to.
 */
export function useExpandScopeItem(owner: ScopeOwnerRef) {
  const openContentSurface = useShellStore((state) => state.openContentSurface);
  return useCallback(
    (item: ScopeItemRef) => {
      void passNavigationGuards().then((passed) => {
        if (!passed) return;
        openContentSurface();
        openScopeOwner(scopeOwnerTargetOf(owner), {
          scopeOpenIntent: { kind: "item", item },
        });
      });
    },
    [openContentSurface, owner],
  );
}

/**
 * An item expanded as the main area object: the surface of its domain shows
 * the screen of the item, and the top bar shows the breadcrumbs of the
 * owner, the surface's tab and the item. The tab breadcrumb opens the owner
 * on that tab. An item whose ready source no longer has it leaves Now and
 * Pinned, and the main area closes.
 */
export function ScopeItemMain({
  owner,
  item,
  surface,
}: {
  owner: ScopeOwnerRef;
  item: ScopeItemRef;
  surface: ScopeSurfaceContribution | undefined;
}) {
  const rootId = useSpace((state) => state.activeRootId);
  const ownerTarget = useMemo(() => scopeOwnerTargetOf(owner), [owner]);
  const key = useMemo(
    () => itemNavigationKey(ownerTarget, item, rootId),
    [item, ownerTarget, rootId],
  );
  const keyId = key ? navigationKeyId(key) : null;
  const expandItem = useExpandScopeItem(owner);
  const surfaceId = item.surfaceId;
  const openSurface = useCallback(() => {
    void passNavigationGuards().then((passed) => {
      if (!passed) return;
      openScopeOwner(ownerTarget, {
        scopeOpenIntent: { kind: "target", surfaceId },
      });
    });
  }, [ownerTarget, surfaceId]);
  const renderTopBar = useCallback(
    (parts: ScopeMainItemTopBar) =>
      surface ? (
        <ScopeItemMainTopBar
          owner={owner}
          keyId={keyId}
          parts={parts}
          surface={surface}
          onOpenSurface={openSurface}
        />
      ) : null,
    [keyId, openSurface, owner, surface],
  );
  const mainItem = useMemo<ScopeMainItem>(
    () => ({
      item,
      renderTopBar,
      registerNavigationGuard: (guard) =>
        registerSupplementalContentDeactivation(async () =>
          (await guard()) ? "ready" : "blocked",
        ),
      onGone: () => {
        if (key) void getNavigationState().forget([key]);
        closeActiveContent();
      },
    }),
    [item, key, renderTopBar],
  );
  if (!surface) return null;
  return (
    <ScopeSurfaceErrorBoundary key={keyId ?? surface.id}>
      {surface.render({
        owner,
        presentation: "full",
        mainItem,
        onExpandItem: expandItem,
      })}
    </ScopeSurfaceErrorBoundary>
  );
}

function ScopeItemMainTopBar({
  owner,
  keyId,
  parts,
  surface,
  onOpenSurface,
}: {
  owner: ScopeOwnerRef;
  keyId: string | null;
  parts: ScopeMainItemTopBar;
  surface: ScopeSurfaceContribution;
  onOpenSurface(): void;
}) {
  const home = useShellView() === "home";
  const openContentSurface = useShellStore((state) => state.openContentSurface);
  const name = parts.identity.name;
  // The item's row in Now takes the name and icon its screen shows.
  const iconRef = useRef(parts.identity.icon);
  useEffect(() => {
    iconRef.current = parts.identity.icon;
  });
  useEffect(() => {
    if (!keyId) return;
    publishNavigationItemDisplays(
      new Map([[keyId, { title: name, icon: iconRef.current }]]),
    );
  }, [keyId, name]);
  const SurfaceIcon = surface.icon;
  const breadcrumbs = (
    <SpaceBreadcrumbs
      home={home}
      spacePath={owner.spacePath}
      path={owner.identityKind === "registered-space" ? null : owner.ownerPath}
      links={[
        {
          key: `surface:${surface.id}`,
          label: surface.label,
          icon: <SurfaceIcon />,
          onOpen: onOpenSurface,
        },
      ]}
      current={
        <BreadcrumbPage
          className="flex min-w-0 max-w-[220px] items-center gap-1.5"
          data-main-item-crumb
        >
          <span
            className="inline-flex size-4 shrink-0 items-center justify-center text-muted-foreground [&_svg]:size-4 [&_[data-slot=avatar]]:size-4!"
            aria-hidden
          >
            {parts.identity.icon}
          </span>
          <span className="truncate">{name}</span>
        </BreadcrumbPage>
      }
      onBeforeNavigation={passNavigationGuards}
      onActivateContent={openContentSurface}
    />
  );
  const objectActions =
    parts.info || parts.menu ? (
      <>
        {parts.info}
        {parts.menu}
      </>
    ) : undefined;
  const publish = (openWith?: OpenWithGroup) => (
    <PublishMainHeader
      breadcrumbs={breadcrumbs}
      objectActions={objectActions}
      viewTools={parts.tools ?? undefined}
      openWith={openWith}
    />
  );
  return parts.openWith ? (
    <ExternalOpenGroupHost render={publish}>
      {parts.openWith}
    </ExternalOpenGroupHost>
  ) : (
    publish()
  );
}
