import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useDictatedDrafts } from "@/features/agent-sessions";
import { GitGate } from "@/features/git/app-shell";
import { RootProjectMenuBridge } from "@/features/home";
import { RootSpacesFollower } from "@/features/space";
import {
  AppPreferencesProvider,
  useAppLocale,
  useAppVersion,
} from "@/features/settings";
import { DogfoodUpdatesProvider } from "@/features/updates";
import { getBuildCommit } from "@/platform/build-info";
import { AppBootstrapScreen, IdentityGate } from "./identity-gate";

/**
 * The one tooltip provider of the window sits above the routed screen, the
 * settings window and the other app-level dialogs.
 */
export function AppProviders() {
  return (
    <TooltipProvider delayDuration={300}>
      <AppPreferencesProvider fallback={<AppBootstrapScreen />}>
        <LocalizedAppProviders />
      </AppPreferencesProvider>
    </TooltipProvider>
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
      <RootSpacesFollower />
      <GitGate fallback={<AppBootstrapScreen />}>
        {(recheckGit) => <IdentityGate onGitUnavailable={recheckGit} />}
      </GitGate>
      <Toaster />
    </DogfoodUpdatesProvider>
  );
}
