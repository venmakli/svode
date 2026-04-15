import { createRootRoute, Outlet } from "@tanstack/react-router";
import { ThemeProvider } from "@/components/ui/theme-provider";
import { Toaster } from "@/components/ui/sonner";
import { useLayoutStore } from "@/stores/layout";
import { AppSettingsDialog } from "@/features/settings/app-settings-dialog";
import { SpaceSettingsDialog } from "@/features/settings/space-settings-dialog";

function SettingsDialogs() {
  const { settingsDialog, settingsSpacePath, closeSettings } = useLayoutStore();

  return (
    <>
      <AppSettingsDialog
        open={settingsDialog === "app"}
        onOpenChange={(open) => { if (!open) closeSettings(); }}
      />
      <SpaceSettingsDialog
        open={settingsDialog === "space"}
        spacePath={settingsSpacePath}
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
