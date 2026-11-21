import { useState } from "react";
import { LoaderCircle } from "lucide-react";
import * as m from "@/paraglide/messages.js";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent } from "@/components/ui/collapsible";
import {
  gitTransferLabel,
  lfsMegabytes,
  lfsUnsentDescription,
} from "@/features/git";
import { useGitTransfer } from "@/features/git/sidebar";
import { lfsMissingDescription, type LfsMissing } from "@/features/space";
import type { UseSpaceStorageSettingsResult } from "../hooks/use-space-storage-settings";
import { SettingsDisclosureTrigger, SettingsItem } from "./settings-layout";

const VISIBLE_FILE_LIMIT = 50;

type LfsFiles = LfsMissing["files"];

// The LFS objects of the repository on this device: the files not sent
// first, then all downloaded, the running download, the files the last
// download left and why, or no access.
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
  const unsent = settings.lfsUnsent;
  const busy = pulling || settings.lfsRepairInFlight;
  const download = pulling
    ? transfer?.direction === "download"
      ? gitTransferLabel(transfer)
      : m.storage_lfs_downloading()
    : noAccess
      ? remote
        ? m.storage_lfs_objects_missing_remote()
        : m.storage_lfs_objects_missing_s3()
      : missing
        ? lfsMissingDescription(missing)
        : unsent
          ? null
          : m.storage_lfs_objects_downloaded();
  const action =
    pulling || missing
      ? m.storage_lfs_download()
      : noAccess && !remote
        ? m.storage_lfs_retry()
        : null;
  const listed = !!unsent || !!missing;

  return (
    <Collapsible open={filesOpen && listed} onOpenChange={setFilesOpen}>
      <SettingsItem
        title={m.storage_lfs_objects()}
        description={
          <>
            {unsent ? (
              <span className="block" data-lfs-unsent-description>
                {lfsUnsentDescription(unsent)}
              </span>
            ) : null}
            {download ? <span className="block">{download}</span> : null}
          </>
        }
        actions={
          action || listed ? (
            <>
              {listed ? (
                <SettingsDisclosureTrigger
                  open={filesOpen}
                  label={
                    filesOpen
                      ? m.storage_lfs_files_hide()
                      : m.storage_lfs_files_show()
                  }
                />
              ) : null}
              {action ? (
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
              ) : null}
            </>
          ) : null
        }
      >
        {listed ? (
          <CollapsibleContent className="flex basis-full flex-col gap-3">
            {unsent ? (
              <LfsFileList
                label={m.storage_lfs_unsent_list()}
                captioned={!!missing}
                files={unsent.files}
              />
            ) : null}
            {missing ? (
              <LfsFileList
                label={m.storage_lfs_files_list()}
                captioned={!!unsent}
                files={missing.files}
              />
            ) : null}
          </CollapsibleContent>
        ) : null}
      </SettingsItem>
    </Collapsible>
  );
}

// One list of files with their sizes; its label shows above it when it is
// one of two lists.
function LfsFileList({
  label,
  captioned,
  files,
}: {
  label: string;
  captioned: boolean;
  files: LfsFiles;
}) {
  const visible = files.slice(0, VISIBLE_FILE_LIMIT);
  const hiddenCount = files.length - visible.length;
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      {captioned ? (
        <p className="text-xs font-medium text-muted-foreground" aria-hidden>
          {label}
        </p>
      ) : null}
      <ul
        aria-label={label}
        className="flex min-w-0 flex-col gap-1 rounded-md bg-muted/50 p-3 font-mono text-xs text-muted-foreground"
      >
        {/* Two versions of one file are two objects to send. */}
        {visible.map((file, index) => (
          <li
            key={`${index}:${file.path}`}
            className="flex min-w-0 items-baseline gap-3"
          >
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
    </div>
  );
}
