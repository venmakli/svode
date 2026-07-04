import { Toaster } from "@/components/ui/sonner";
import { ThemeProvider } from "@/components/ui/theme-provider";
import { RootProjectMenuBridge } from "@/features/home";
import { useAppVersion } from "@/features/settings";
import { DogfoodUpdateNotifier } from "@/features/updates";
import { getBuildCommit } from "@/platform/build-info";
import { IdentityGate } from "./identity-gate";

export function AppProviders() {
  const version = useAppVersion();
  const buildCommit = getBuildCommit();

  return (
    <ThemeProvider defaultTheme="system" storageKey="svode-theme">
      <DogfoodUpdateNotifier version={version} buildCommit={buildCommit} />
      <RootProjectMenuBridge />
      <IdentityGate />
      <Toaster />
    </ThemeProvider>
  );
}
