import { useEffect } from "react";
import type { Page } from "@/features/page";
import type { ActiveTab } from "../model";
import type { CollectionView } from "../query";
import { handleError } from "./error-feedback";
import { isEditableTarget } from "./is-editable-target";

export function useCollectionKeyboardShortcuts({
  activeTab,
  views,
  selectTab,
  moveActive,
  focusActiveViewCreate,
  createEntry,
  readOnly,
}: {
  activeTab: ActiveTab;
  views: CollectionView[];
  selectTab: (next: ActiveTab) => void;
  moveActive: (offset: number) => Promise<void>;
  focusActiveViewCreate: (asFolder: boolean) => boolean;
  createEntry: (asFolder?: boolean) => Promise<Page>;
  readOnly: boolean;
}) {
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (isEditableTarget(event.target)) return;
      if (!(event.ctrlKey || event.metaKey)) return;
      if (event.shiftKey && event.key === "ArrowRight") {
        event.preventDefault();
        if (readOnly) return;
        void moveActive(1).catch(handleError);
        return;
      }
      if (event.shiftKey && event.key === "ArrowLeft") {
        event.preventDefault();
        if (readOnly) return;
        void moveActive(-1).catch(handleError);
        return;
      }
      if (!event.shiftKey && event.key === "ArrowRight") {
        const tabs = collectionTabs(views);
        if (tabs.length === 0) return;
        event.preventDefault();
        const index = tabs.indexOf(activeTab);
        selectTab(tabs[Math.min(tabs.length - 1, index + 1)] ?? activeTab);
        return;
      }
      if (!event.shiftKey && event.key === "ArrowLeft") {
        const tabs = collectionTabs(views);
        if (tabs.length === 0) return;
        event.preventDefault();
        const index = tabs.indexOf(activeTab);
        selectTab(tabs[Math.max(0, index - 1)] ?? activeTab);
        return;
      }
      const numeric = Number(event.key);
      if (numeric >= 1 && numeric <= 9) {
        const tabs = collectionTabs(views);
        const next = tabs[numeric - 1];
        if (next) {
          event.preventDefault();
          selectTab(next);
        }
        return;
      }
      if (!event.shiftKey && event.key.toLowerCase() === "n") {
        event.preventDefault();
        if (readOnly) return;
        if (focusActiveViewCreate(false)) return;
        void createEntry(false).catch(handleError);
        return;
      }
      if (event.shiftKey && event.key.toLowerCase() === "n") {
        event.preventDefault();
        if (readOnly) return;
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
    moveActive,
    readOnly,
    selectTab,
    views,
  ]);
}

function collectionTabs(views: CollectionView[]) {
  return views.map((view) => view.name);
}
