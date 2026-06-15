import { createRootRoute, Outlet } from "@tanstack/react-router";
import { ThemeProvider } from "@/components/ui/theme-provider";
import { Toaster } from "@/components/ui/sonner";
import { useShellStore } from "@/app/shell/model";
import { AppSettingsDialog } from "@/features/settings/app-settings-dialog";
import { SpaceSettingsDialog } from "@/features/settings/space-settings-dialog";
import { IdentityDialog } from "@/features/identity/identity-dialog";
import { useIdentityCheck } from "@/features/identity/use-identity-check";
import { useIdentityStore } from "@/features/identity/identity-store";
import { DogfoodUpdateNotifier } from "@/features/updates";

function SettingsDialogs() {
  const { settingsDialog, settingsSpacePath, closeSettings } = useShellStore();

  return (
    <>
      <AppSettingsDialog
        open={settingsDialog === "app"}
        onOpenChange={(open) => {
          if (!open) closeSettings();
        }}
      />
      <SpaceSettingsDialog
        open={settingsDialog === "space"}
        spacePath={settingsSpacePath}
        onOpenChange={(open) => {
          if (!open) closeSettings();
        }}
      />
    </>
  );
}

function IdentityGate() {
  useIdentityCheck();
  const loaded = useIdentityStore((s) => s.loaded);
  const source = useIdentityStore((s) => s.source);

  if (!loaded) {
    return <div className="h-screen w-screen" />;
  }

  if (source === "missing") {
    return <IdentityDialog open={true} />;
  }

  return (
    <>
      <Outlet />
      <SettingsDialogs />
    </>
  );
}

export const Route = createRootRoute({
  component: () => (
    <ThemeProvider defaultTheme="system">
      <DogfoodUpdateNotifier />
      <IdentityGate />
      <Toaster />
    </ThemeProvider>
  ),
});
