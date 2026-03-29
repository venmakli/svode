import { createRootRoute, Outlet } from "@tanstack/react-router";
import { ThemeProvider } from "@/components/ui/theme-provider";
import { Toaster } from "@/components/ui/sonner";
import { useLayoutStore } from "@/stores/layout";
import { AppSettingsDialog } from "@/features/settings/app-settings-dialog";
import { ProjectSettingsDialog } from "@/features/settings/project-settings-dialog";
import { WorkspaceSettingsDialog } from "@/features/settings/workspace-settings-dialog";

function SettingsDialogs() {
  const { settingsDialog, settingsWorkspaceId, closeSettings } = useLayoutStore();
  return (
    <>
      <AppSettingsDialog
        open={settingsDialog === "app"}
        onOpenChange={(open) => { if (!open) closeSettings(); }}
      />
      <ProjectSettingsDialog
        open={settingsDialog === "project"}
        onOpenChange={(open) => { if (!open) closeSettings(); }}
      />
      <WorkspaceSettingsDialog
        open={settingsDialog === "workspace"}
        workspaceId={settingsWorkspaceId}
        onOpenChange={(open) => { if (!open) closeSettings(); }}
      />
    </>
  );
}

export const Route = createRootRoute({
  component: () => (
    <ThemeProvider defaultTheme="system">
      <Outlet />
      <Toaster />
      <SettingsDialogs />
    </ThemeProvider>
  ),
});
