import { Toaster } from "@/components/ui/sonner";
import { ThemeProvider } from "@/components/ui/theme-provider";
import { RootProjectMenuBridge } from "@/features/home";
import {
  AppLocaleProvider,
  useAppLocale,
  useAppVersion,
} from "@/features/settings";
import { DogfoodUpdateNotifier } from "@/features/updates";
import { getBuildCommit } from "@/platform/build-info";
import { AppBootstrapScreen, IdentityGate } from "./identity-gate";

export function AppProviders() {
  return (
    <ThemeProvider defaultTheme="system" storageKey="svode-theme">
      <AppLocaleProvider fallback={<AppBootstrapScreen />}>
        <LocalizedAppProviders />
      </AppLocaleProvider>
    </ThemeProvider>
  );
}

function LocalizedAppProviders() {
  useAppLocale();
  const version = useAppVersion();
  const buildCommit = getBuildCommit();

  return (
    <>
      <DogfoodUpdateNotifier version={version} buildCommit={buildCommit} />
      <RootProjectMenuBridge />
      <IdentityGate />
      <Toaster />
    </>
  );
}
