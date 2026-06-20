import { Toaster } from "@/components/ui/sonner";
import { ThemeProvider } from "@/components/ui/theme-provider";
import { useAppVersion } from "@/features/settings";
import { DogfoodUpdateNotifier, getBuildCommit } from "@/features/updates";
import { IdentityGate } from "./identity-gate";

export function AppProviders() {
  const version = useAppVersion();
  const buildCommit = getBuildCommit();

  return (
    <ThemeProvider defaultTheme="system" storageKey="svode-theme">
      <DogfoodUpdateNotifier version={version} buildCommit={buildCommit} />
      <IdentityGate />
      <Toaster />
    </ThemeProvider>
  );
}
