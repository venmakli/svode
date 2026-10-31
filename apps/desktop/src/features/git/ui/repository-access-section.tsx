import { useState } from "react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import * as m from "@/paraglide/messages.js";

import type { RepositoryAccessSnapshot } from "../model/repository-access";
import type { RepositoryAccessPresentation } from "./repository-access-copy";
import { RepositoryAccessStatusIcon } from "./repository-access-status-icon";

export interface RepositoryAccessSectionProps {
  presentation: RepositoryAccessPresentation;
  verify(): Promise<RepositoryAccessSnapshot | null>;
  onOpenSettings?: () => void;
}

// The access part of the Git sync Dialog (Stage 11 1.E): nothing while
// editing is available, an Alert with the reason and its recovery action
// otherwise — read only, sign-in needed or access not verified.
export function RepositoryAccessSection({
  presentation,
  verify,
  onOpenSettings,
}: RepositoryAccessSectionProps) {
  const [recommendationsOpen, setRecommendationsOpen] = useState(false);
  const settingsAvailable = Boolean(onOpenSettings);
  const primaryOpensSettings =
    presentation.action === "authenticate" ||
    presentation.action === "edit_remote";
  const showPrimaryAction =
    presentation.action !== "none" &&
    presentation.actionLabel &&
    (!primaryOpensSettings || settingsAvailable);

  switch (presentation.status) {
    case "local":
    case "writable":
    case "loading":
    case "checking":
      return null;
    case "read_only":
    case "unknown":
    case "error":
      break;
  }

  function runPrimaryAction() {
    switch (presentation.action) {
      case "verify":
        void verify();
        break;
      case "authenticate":
      case "edit_remote":
        onOpenSettings?.();
        break;
      case "recommendations":
        setRecommendationsOpen(true);
        break;
      case "none":
        break;
    }
  }

  const settingsButton =
    settingsAvailable && !primaryOpensSettings ? (
      <Button type="button" size="sm" variant="ghost" onClick={onOpenSettings}>
        {m.git_access_preflight_open_settings()}
      </Button>
    ) : null;

  return (
    <Alert
      data-repository-access-section
      data-repository-access-section-status={presentation.status}
    >
      <RepositoryAccessStatusIcon status={presentation.status} busy={false} />
      <AlertTitle>{presentation.title}</AlertTitle>
      <AlertDescription className="flex flex-col gap-2">
        <p>{presentation.description}</p>
        {recommendationsOpen ? (
          <p className="text-xs" role="status">
            {m.git_access_unsupported_ref_recommendations()}
          </p>
        ) : null}
        {showPrimaryAction || settingsButton ? (
          <div className="flex flex-wrap gap-2">
            {showPrimaryAction ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={runPrimaryAction}
              >
                {presentation.actionLabel}
              </Button>
            ) : null}
            {settingsButton}
          </div>
        ) : null}
      </AlertDescription>
    </Alert>
  );
}
