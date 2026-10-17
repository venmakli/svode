import { Button } from "@/components/ui/button";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import * as m from "@/paraglide/messages.js";

import type { RepositoryAccessPreflightController } from "../hooks/use-repository-access-preflight";
import type { RepositoryAccessTargetView } from "../model/repository-access-consumer";
import { repositoryAccessPresentation } from "./repository-access-copy";
import { RepositoryAccessStatusIcon } from "./repository-access-status-icon";

/**
 * The recovery set as compact rows for a consumer's own Dialog: identity,
 * status with a short reason and the exact Git settings of each repository.
 * The consumer owns the Dialog, its copy and the primary action.
 */
export function RepositoryAccessBlockerItems({
  recovery,
  onOpenSettings,
}: {
  recovery: RepositoryAccessPreflightController;
  /** Runs before a row opens its Git settings, e.g. to close the host Dialog. */
  onOpenSettings?: () => void;
}) {
  if (!recovery.open || !recovery.pending) return null;
  // Once nothing blocks, the same rows show the repositories as ready.
  const rows = recovery.blockers.length
    ? recovery.blockers
    : recovery.targetViews;
  return (
    <div
      className="flex max-h-72 min-w-0 flex-col gap-2 overflow-y-auto"
      aria-busy={recovery.busy}
      data-repository-access-blocker-items={recovery.pending.intentKey}
    >
      <ItemGroup className="gap-2">
        {rows.map((row) => (
          <RepositoryAccessBlockerItem
            key={row.access.snapshot?.repositoryId ?? row.target.repositoryPath}
            row={row}
            showSettings={
              !(
                recovery.primaryOpensSettings && row === recovery.primaryBlocker
              )
            }
            onOpenSettings={onOpenSettings}
          />
        ))}
      </ItemGroup>
      {recovery.recommendationsOpen ? (
        <p className="text-sm text-muted-foreground" role="status">
          {m.git_access_unsupported_ref_recommendations()}
        </p>
      ) : null}
    </div>
  );
}

function RepositoryAccessBlockerItem({
  row: { access, target },
  showSettings,
  onOpenSettings,
}: {
  row: RepositoryAccessTargetView;
  showSettings: boolean;
  onOpenSettings?: () => void;
}) {
  const presentation = repositoryAccessPresentation(access);
  const name =
    target.namedByPath && target.displayPath
      ? target.displayPath
      : target.displayName;
  const reason = blockingReason(presentation);
  const openSettings = showSettings ? target.openSettings : undefined;
  return (
    <Item
      role="listitem"
      size="sm"
      variant="outline"
      className="flex-nowrap"
      title={target.displayPath || target.displayName}
      data-repository-access-blocker-item={
        access.snapshot?.repositoryId ?? "loading"
      }
      data-repository-access-status={presentation.status}
    >
      <ItemMedia
        variant="icon"
        className={
          presentation.status === "read_only" || presentation.status === "error"
            ? "text-destructive"
            : "text-muted-foreground"
        }
      >
        <RepositoryAccessStatusIcon
          status={presentation.status}
          busy={presentation.status === "checking"}
        />
      </ItemMedia>
      <ItemContent className="min-w-0">
        <ItemTitle className="block w-full truncate">{name}</ItemTitle>
        <ItemDescription>
          {reason
            ? `${presentation.statusLabel} · ${reason}`
            : presentation.statusLabel}
        </ItemDescription>
      </ItemContent>
      {openSettings ? (
        <ItemActions>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => {
              onOpenSettings?.();
              openSettings();
            }}
          >
            {m.git_access_settings_action()}
          </Button>
        </ItemActions>
      ) : null}
    </Item>
  );
}

/** Only a refusing state explains itself; progress and ready states don't. */
function blockingReason(
  presentation: ReturnType<typeof repositoryAccessPresentation>,
) {
  return presentation.status === "unknown" ||
    presentation.status === "read_only" ||
    presentation.status === "error"
    ? presentation.description
    : null;
}
