import { useRef, useState, type ReactNode } from "react";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import * as m from "@/paraglide/messages.js";
import { detailPageToolbarClassName } from "@/shared/ui/page-layout";

type PageOwnerSurfaceId = "page" | "attachments";

export function PageOwnerTabs({
  attachments,
  page,
  prepareForPageDeactivation,
}: {
  attachments: ReactNode;
  page: ReactNode;
  prepareForPageDeactivation(): Promise<boolean>;
}) {
  const [activeSurface, setActiveSurface] =
    useState<PageOwnerSurfaceId>("page");
  const [transitionPending, setTransitionPending] = useState(false);
  const transitionPendingRef = useRef(false);

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
      className="gap-0"
      aria-busy={transitionPending}
      data-page-owner-surface={activeSurface}
    >
      <div className={detailPageToolbarClassName}>
        <TabsList variant="line">
          <TabsTrigger value="page">{m.page_surface_page()}</TabsTrigger>
          <TabsTrigger value="attachments">
            {m.scope_surface_attachments()}
          </TabsTrigger>
        </TabsList>
      </div>
      <TabsContent value={activeSurface} className="flex-none">
        {activeSurface === "page" ? page : attachments}
      </TabsContent>
    </Tabs>
  );
}
