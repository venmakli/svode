import { useState } from "react";

import { Button } from "@/components/ui/button";
import * as m from "@/paraglide/messages.js";

import type { RepositoryAccessSnapshot } from "../model/repository-access";
import type { RepositoryAccessPresentation } from "./repository-access-copy";
import { RepositoryAccessStatusIcon } from "./repository-access-status-icon";

export interface RepositoryAccessSectionProps {
  presentation: RepositoryAccessPresentation;
  repositoryPath: string;
  verify(): Promise<RepositoryAccessSnapshot | null>;
  onOpenSettings?: () => void;
}

// The access part of the repository screen: a quiet status line when editing
// is available, the reason and its recovery action otherwise.
export function RepositoryAccessSection({
  presentation,
  repositoryPath,
  verify,
  onOpenSettings,
}: RepositoryAccessSectionProps) {
  const [recommendationsOpen, setRecommendationsOpen] = useState(false);
  const busy = presentation.status === "checking";
  const settingsAvailable = Boolean(onOpenSettings);
  const primaryOpensSettings =
    presentation.action === "authenticate" ||
    presentation.action === "edit_remote";
  const showPrimaryAction =
    presentation.action !== "none" &&
    presentation.actionLabel &&
    (!primaryOpensSettings || settingsAvailable);
  const quiet =
    presentation.status === "local" ||
    presentation.status === "writable" ||
    presentation.status === "loading";

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
      <Button
        type="button"
        size={quiet ? "xs" : "sm"}
        variant="ghost"
        onClick={onOpenSettings}
      >
        {m.git_access_preflight_open_settings()}
      </Button>
    ) : null;

  if (quiet) {
    return (
      <section
        className="flex min-w-0 items-center gap-2 text-sm"
        aria-live="polite"
        data-repository-access-section
        data-repository-access-section-status={presentation.status}
      >
        <span className="flex min-w-0 flex-1 items-center gap-2 text-muted-foreground [&_svg]:size-4 [&_svg]:shrink-0">
          <RepositoryAccessStatusIcon
            status={presentation.status}
            busy={false}
          />
          <span className="shrink-0">{presentation.title}</span>
          <span className="truncate text-xs" title={repositoryPath}>
            {repositoryPath}
          </span>
        </span>
        {settingsButton}
      </section>
    );
  }

  return (
    <section
      className="flex min-w-0 flex-col gap-2"
      aria-busy={busy}
      data-repository-access-section
      data-repository-access-section-status={presentation.status}
    >
      <div className="flex min-w-0 flex-col gap-1" aria-live="polite">
        <h3 className="flex items-center gap-2 text-sm font-medium [&_svg]:size-4 [&_svg]:shrink-0">
          <RepositoryAccessStatusIcon
            status={presentation.status}
            busy={busy}
          />
          {presentation.title}
        </h3>
        <p className="text-sm text-muted-foreground">
          {presentation.description}
        </p>
        <p
          className="truncate text-xs text-muted-foreground"
          title={repositoryPath}
        >
          {repositoryPath}
        </p>
      </div>
      {recommendationsOpen ? (
        <p className="text-xs text-muted-foreground" role="status">
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
              disabled={busy}
              onClick={runPrimaryAction}
            >
              {presentation.actionLabel}
            </Button>
          ) : null}
          {settingsButton}
        </div>
      ) : null}
    </section>
  );
}
