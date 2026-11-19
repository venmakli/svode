import { useState } from "react";
import { LoaderCircle } from "lucide-react";
import * as m from "@/paraglide/messages.js";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent } from "@/components/ui/collapsible";
import { gitTransferLabel } from "@/features/git";
import { useGitTransfer } from "@/features/git/sidebar";
import {
  lfsMegabytes,
  lfsMissingDescription,
  type LfsMissing,
} from "@/features/space";
import type { UseSpaceStorageSettingsResult } from "../hooks/use-space-storage-settings";
import { SettingsDisclosureTrigger, SettingsItem } from "./settings-layout";

const VISIBLE_FILE_LIMIT = 50;

// The LFS objects of the repository on this device: all downloaded, the
// running download, the files the last download left and why, or no access.
export function StorageLfsObjectsRow({
  settings,
}: {
  settings: UseSpaceStorageSettingsResult;
}) {
  const [filesOpen, setFilesOpen] = useState(false);
  const transfer = useGitTransfer(settings.currentSpacePath);
  const state = settings.lfsState;
  const remote = settings.savedAssetsStrategy === "lfs-remote";
  const pulling = state === "pulling";
  const noAccess = state === "missing-creds";
  const missing = state === "ready" ? settings.lfsMissing : null;
  const busy = pulling || settings.lfsRepairInFlight;
  const description = pulling
    ? transfer?.direction === "download"
      ? gitTransferLabel(transfer)
      : m.storage_lfs_downloading()
    : noAccess
      ? remote
        ? m.storage_lfs_objects_missing_remote()
        : m.storage_lfs_objects_missing_s3()
      : missing
        ? lfsMissingDescription(missing)
        : m.storage_lfs_objects_downloaded();
  const action =
    pulling || missing
      ? m.storage_lfs_download()
      : noAccess && !remote
        ? m.storage_lfs_retry()
        : null;

  return (
    <Collapsible open={filesOpen && !!missing} onOpenChange={setFilesOpen}>
      <SettingsItem
        title={m.storage_lfs_objects()}
        description={description}
        actions={
          action ? (
            <>
              {missing ? (
                <SettingsDisclosureTrigger
                  open={filesOpen}
                  label={
                    filesOpen
                      ? m.storage_lfs_files_hide()
                      : m.storage_lfs_files_show()
                  }
                />
              ) : null}
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => void settings.repairLfs()}
              >
                {busy ? (
                  <LoaderCircle
                    data-icon="inline-start"
                    className="animate-spin"
                  />
                ) : null}
                {action}
              </Button>
            </>
          ) : null
        }
      >
        {missing ? (
          <CollapsibleContent className="basis-full">
            <LfsMissingFiles missing={missing} />
          </CollapsibleContent>
        ) : null}
      </SettingsItem>
    </Collapsible>
  );
}

function LfsMissingFiles({ missing }: { missing: LfsMissing }) {
  const visible = missing.files.slice(0, VISIBLE_FILE_LIMIT);
  const hiddenCount = missing.files.length - visible.length;
  return (
    <ul
      aria-label={m.storage_lfs_files_list()}
      className="flex min-w-0 flex-col gap-1 rounded-md bg-muted/50 p-3 font-mono text-xs text-muted-foreground"
    >
      {visible.map((file) => (
        <li key={file.path} className="flex min-w-0 items-baseline gap-3">
          <span className="min-w-0 flex-1 break-all">{file.path}</span>
          <span className="shrink-0 font-sans tabular-nums">
            {lfsMegabytes(file.size)}
          </span>
        </li>
      ))}
      {hiddenCount > 0 ? (
        <li className="font-sans">
          {m.storage_lfs_policy_more({ count: String(hiddenCount) })}
        </li>
      ) : null}
    </ul>
  );
}
