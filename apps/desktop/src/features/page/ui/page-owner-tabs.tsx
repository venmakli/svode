import { useEffect, useRef, useState, type ReactNode } from "react";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import * as m from "@/paraglide/messages.js";
import { detailPageToolbarClassName } from "@/shared/ui/page-layout";

type PageOwnerSurfaceId = "page" | "app" | "attachments";

export function PageOwnerTabs({
  attachments,
  app,
  page,
  prepareForPageDeactivation,
}: {
  attachments?: ReactNode;
  app?: ReactNode;
  page: ReactNode;
  prepareForPageDeactivation(): Promise<boolean>;
}) {
  const [activeSurface, setActiveSurface] =
    useState<PageOwnerSurfaceId>("page");
  const [transitionPending, setTransitionPending] = useState(false);
  const transitionPendingRef = useRef(false);

  useEffect(() => {
    if (
      (activeSurface === "attachments" && !attachments) ||
      (activeSurface === "app" && !app)
    ) {
      setActiveSurface("page");
    }
  }, [activeSurface, app, attachments]);

  const activeContent =
    activeSurface === "page"
      ? page
      : activeSurface === "app"
        ? app
        : attachments;
  const appActive = activeSurface === "app";

  return (
    <Tabs
      value={activeSurface}
      onValueChange={(value) => {
        const next = value as PageOwnerSurfaceId;
        if (next === activeSurface || transitionPendingRef.current) return;
        transitionPendingRef.current = true;
        setTransitionPending(true);
        void (async () => {
          try {
            if (
              activeSurface === "page" &&
              !(await prepareForPageDeactivation())
            ) {
              return;
            }
            setActiveSurface(next);
          } finally {
            transitionPendingRef.current = false;
            setTransitionPending(false);
          }
        })();
      }}
      className={appActive ? "flex min-h-0 flex-1 flex-col gap-0" : "gap-0"}
      aria-busy={transitionPending}
      data-page-owner-surface={activeSurface}
    >
      <div className={detailPageToolbarClassName}>
        <TabsList variant="line">
          <TabsTrigger value="page">{m.page_surface_page()}</TabsTrigger>
          {app ? (
            <TabsTrigger value="app">{m.scope_surface_app()}</TabsTrigger>
          ) : null}
          {attachments ? (
            <TabsTrigger value="attachments">
              {m.scope_surface_attachments()}
            </TabsTrigger>
          ) : null}
        </TabsList>
      </div>
      <TabsContent
        value={activeSurface}
        className={appActive ? "min-h-0 flex-1 overflow-hidden" : "flex-none"}
      >
        {activeContent}
      </TabsContent>
    </Tabs>
  );
}
