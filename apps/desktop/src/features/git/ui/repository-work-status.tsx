import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";
import * as m from "@/paraglide/messages.js";

import { useRepositoryAccess } from "../hooks/use-repository-access";
import { repositoryAccessPresentation } from "./repository-access-copy";
import { RepositoryAccessStatusIcon } from "./repository-access-status-icon";

export interface RepositoryWorkStatusProps {
  contextName: string;
  displayPath: string;
  repositoryPath: string;
  onOpenRepositorySettings?: (repositoryPath: string) => void;
}

export function RepositoryWorkStatus({
  contextName,
  displayPath,
  repositoryPath,
  onOpenRepositorySettings,
}: RepositoryWorkStatusProps) {
  const access = useRepositoryAccess(repositoryPath);
  const presentation = repositoryAccessPresentation(access);
  const [open, setOpen] = useState(false);
  const [recommendationsOpen, setRecommendationsOpen] = useState(false);
  const busy =
    access.verifying ||
    presentation.status === "checking" ||
    presentation.status === "loading";
  const statusLabel = repositoryWorkStatusLabel(presentation.status);
  const settingsAvailable = Boolean(onOpenRepositorySettings);
  const primaryOpensSettings =
    presentation.action === "authenticate" ||
    presentation.action === "edit_remote";
  const showPrimaryAction =
    presentation.action !== "none" &&
    presentation.actionLabel &&
    (!primaryOpensSettings || settingsAvailable);

  function runPrimaryAction() {
    switch (presentation.action) {
      case "verify":
        void access.verify();
        break;
      case "authenticate":
      case "edit_remote":
        openSettings();
        break;
      case "recommendations":
        setRecommendationsOpen(true);
        break;
      case "none":
        break;
    }
  }

  function openSettings() {
    setOpen(false);
    onOpenRepositorySettings?.(repositoryPath);
  }

  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (!nextOpen) setRecommendationsOpen(false);
      }}
    >
      <PopoverTrigger asChild>
        <Button
          type="button"
          size="sm"
          variant="outline"
          aria-busy={busy}
          aria-label={m.repository_work_status_accessible({
            name: contextName,
            status: statusLabel,
          })}
          data-repository-work-status
          data-repository-work-status-state={presentation.status}
        >
          <RepositoryAccessStatusIcon
            status={presentation.status}
            busy={busy}
          />
          <span className="hidden max-w-40 truncate lg:inline">
            {statusLabel}
          </span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80">
        <PopoverHeader aria-live="polite">
          <PopoverTitle>{presentation.title}</PopoverTitle>
          <PopoverDescription>{presentation.description}</PopoverDescription>
        </PopoverHeader>
        <p
          className="truncate text-xs text-muted-foreground"
          title={displayPath}
        >
          {displayPath}
        </p>
        {recommendationsOpen ? (
          <p className="text-xs text-muted-foreground" role="status">
            {m.git_access_unsupported_ref_recommendations()}
          </p>
        ) : null}
        {showPrimaryAction || settingsAvailable ? (
          <div className="flex flex-wrap justify-end gap-2">
            {settingsAvailable && !primaryOpensSettings ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={openSettings}
              >
                {m.git_access_preflight_open_settings()}
              </Button>
            ) : null}
            {showPrimaryAction ? (
              <Button
                type="button"
                size="sm"
                disabled={busy}
                onClick={runPrimaryAction}
              >
                {presentation.actionLabel}
              </Button>
            ) : null}
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

function repositoryWorkStatusLabel(
  status: ReturnType<typeof repositoryAccessPresentation>["status"],
) {
  switch (status) {
    case "local":
    case "writable":
      return m.repository_work_status_editable();
    case "loading":
      return m.repository_work_status_loading();
    case "checking":
      return m.repository_work_status_checking();
    case "read_only":
    case "unknown":
    case "error":
      return m.repository_work_status_read_only();
  }
}
