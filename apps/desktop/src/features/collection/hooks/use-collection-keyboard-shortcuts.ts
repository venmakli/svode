import { useEffect } from "react";
import type { Entry } from "@/features/entry";
import type { ActiveTab } from "../model";
import type { CollectionView } from "../query";
import { handleError } from "../lib/errors";
import { isEditableTarget } from "./is-editable-target";

export function useCollectionKeyboardShortcuts({
  activeTab,
  hasReadme,
  views,
  selectTab,
  moveActive,
  focusActiveViewCreate,
  createEntry,
}: {
  activeTab: ActiveTab;
  hasReadme: boolean;
  views: CollectionView[];
  selectTab: (next: ActiveTab) => void;
  moveActive: (offset: number) => Promise<void>;
  focusActiveViewCreate: (asFolder: boolean) => boolean;
  createEntry: (asFolder?: boolean) => Promise<Entry>;
}) {
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (isEditableTarget(event.target)) return;
      if (!(event.ctrlKey || event.metaKey)) return;
      if (event.shiftKey && event.key === "ArrowRight") {
        event.preventDefault();
        void moveActive(1).catch(handleError);
        return;
      }
      if (event.shiftKey && event.key === "ArrowLeft") {
        event.preventDefault();
        void moveActive(-1).catch(handleError);
        return;
      }
      if (!event.shiftKey && event.key === "ArrowRight") {
        event.preventDefault();
        const tabs = collectionTabs(hasReadme, views);
        const index = tabs.indexOf(activeTab);
        selectTab(tabs[Math.min(tabs.length - 1, index + 1)] ?? activeTab);
        return;
      }
      if (!event.shiftKey && event.key === "ArrowLeft") {
        event.preventDefault();
        const tabs = collectionTabs(hasReadme, views);
        const index = tabs.indexOf(activeTab);
        selectTab(tabs[Math.max(0, index - 1)] ?? activeTab);
        return;
      }
      const numeric = Number(event.key);
      if (numeric >= 1 && numeric <= 9) {
        const tabs = collectionTabs(hasReadme, views);
        const next = tabs[numeric - 1];
        if (next) {
          event.preventDefault();
          selectTab(next);
        }
        return;
      }
      if (!event.shiftKey && event.key.toLowerCase() === "n") {
        event.preventDefault();
        if (focusActiveViewCreate(false)) return;
        void createEntry(false).catch(handleError);
        return;
      }
      if (event.shiftKey && event.key.toLowerCase() === "n") {
        event.preventDefault();
        if (focusActiveViewCreate(true)) return;
        void createEntry(true).catch(handleError);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    activeTab,
    createEntry,
    focusActiveViewCreate,
    hasReadme,
    moveActive,
    selectTab,
    views,
  ]);
}

function collectionTabs(hasReadme: boolean, views: CollectionView[]) {
  return [hasReadme ? "document" : null, ...views.map((view) => view.name)].filter(
    Boolean,
  ) as string[];
}
