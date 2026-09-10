import { Toaster } from "@/components/ui/sonner";
import { RootProjectMenuBridge } from "@/features/home";
import {
  AppPreferencesProvider,
  useAppLocale,
  useAppVersion,
} from "@/features/settings";
import { DogfoodUpdatesProvider } from "@/features/updates";
import { getBuildCommit } from "@/platform/build-info";
import { AppBootstrapScreen, IdentityGate } from "./identity-gate";

export function AppProviders() {
  return (
    <AppPreferencesProvider fallback={<AppBootstrapScreen />}>
      <LocalizedAppProviders />
    </AppPreferencesProvider>
  );
}

function LocalizedAppProviders() {
  useAppLocale();
  const version = useAppVersion();
  const buildCommit = getBuildCommit();

  return (
    <DogfoodUpdatesProvider version={version} buildCommit={buildCommit}>
      <RootProjectMenuBridge />
      <IdentityGate />
      <Toaster />
    </DogfoodUpdatesProvider>
  );
}
