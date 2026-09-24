import { useState, type ReactNode } from "react";
import { LoaderCircle } from "lucide-react";
import * as m from "@/paraglide/messages.js";
import { Button } from "@/components/ui/button";
import type { UseSpaceStorageSettingsResult } from "../hooks/use-space-storage-settings";
import { SettingsActions } from "./settings-layout";

// The one action that applies a strategy draft. It closes the last group the
// draft needs, after that group's own secondary actions.
export function StorageApplyActions({
  settings,
  children,
}: {
  settings: UseSpaceStorageSettingsResult;
  children?: ReactNode;
}) {
  const applying =
    settings.applyingStrategy &&
    settings.strategyInFlight === settings.assetsStrategy;
  return (
    <SettingsActions>
      {children}
      <Button
        type="button"
        disabled={!settings.canApplyStrategy}
        onClick={() => void settings.applySelectedStrategy()}
      >
        {applying ? (
          <LoaderCircle data-icon="inline-start" className="animate-spin" />
        ) : null}
        {m.storage_apply_action()}
      </Button>
    </SettingsActions>
  );
}

// Several buttons start the same storage write; each shows progress only
// for the write it started.
export function useStorageAction() {
  const [running, setRunning] = useState(false);
  function run(action: () => Promise<void>) {
    setRunning(true);
    void action().finally(() => setRunning(false));
  }
  return [running, run] as const;
}
