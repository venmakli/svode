import type { ReactNode } from "react";
import { Command } from "@/components/ui/command";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarProvider,
  SidebarSeparator,
} from "@/components/ui/sidebar";

export function SearchDialogShell({
  breadcrumb,
  commandValue,
  graph,
  openGraphAction,
  readingContent,
  resetAction,
  scopeControls,
  searchInput,
  sidebarLabel,
  status,
  onCommandValueChange,
}: {
  breadcrumb: ReactNode;
  commandValue: string;
  graph: ReactNode;
  openGraphAction: ReactNode;
  readingContent: ReactNode;
  resetAction: ReactNode;
  scopeControls: ReactNode;
  searchInput: ReactNode;
  sidebarLabel: string;
  status: ReactNode;
  onCommandValueChange: (value: string) => void;
}) {
  return (
    <SidebarProvider
      className="h-full min-h-0 min-w-0 flex-col items-stretch overflow-hidden lg:flex-row"
      style={{ minHeight: 0 }}
      data-search-layout
    >
      <Sidebar
        collapsible="none"
        role="complementary"
        aria-label={sidebarLabel}
        className="h-[46%] min-h-56 w-full max-w-full shrink-0 lg:h-full lg:min-h-0 lg:w-64 lg:max-w-64"
        data-search-sidebar
      >
        <Command
          shouldFilter={false}
          value={commandValue}
          onValueChange={onCommandValueChange}
          loop
          className="min-h-0 rounded-none! bg-sidebar p-0 text-sidebar-foreground"
        >
          <SidebarHeader>
            {searchInput}
            {scopeControls}
          </SidebarHeader>
          <SidebarSeparator />
          <SidebarContent
            className="overflow-hidden"
            data-search-reading-scroll-owner
          >
            {readingContent}
          </SidebarContent>
          <SidebarSeparator />
          <SidebarFooter>{status}</SidebarFooter>
        </Command>
      </Sidebar>
      <main
        className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
        data-search-main
      >
        <header className="flex h-12 min-w-0 shrink-0 items-center gap-3 border-b px-3">
          <div className="min-w-0 flex-1">{breadcrumb}</div>
          {openGraphAction}
        </header>
        <div
          className="relative min-h-0 min-w-0 flex-1 overflow-hidden"
          data-search-canvas
        >
          {graph}
          <div className="absolute top-3 right-3">{resetAction}</div>
        </div>
      </main>
    </SidebarProvider>
  );
}
