import { Toaster } from "@/components/ui/sonner";
import { useDictatedDrafts } from "@/features/agent-sessions";
import { GitGate } from "@/features/git/app-shell";
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
  useDictatedDrafts();
  const version = useAppVersion();
  const buildCommit = getBuildCommit();

  return (
    <DogfoodUpdatesProvider version={version} buildCommit={buildCommit}>
      <RootProjectMenuBridge />
      <GitGate fallback={<AppBootstrapScreen />}>
        {(recheckGit) => <IdentityGate onGitUnavailable={recheckGit} />}
      </GitGate>
      <Toaster />
    </DogfoodUpdatesProvider>
  );
}
