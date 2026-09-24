import { LoaderCircle, RefreshCw } from "lucide-react";
import * as m from "@/paraglide/messages.js";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { LfsPolicyDiagnostic } from "../api";
import { SettingsItem } from "./settings-layout";

const VISIBLE_PATH_LIMIT = 5;

const DECLARATION_LABELS: Record<
  Exclude<NonNullable<LfsPolicyDiagnostic["lfsDeclaration"]>, "missing">,
  () => string
> = {
  published: m.storage_lfs_declaration_published,
  pending: m.storage_lfs_declaration_pending,
  foreign: m.storage_lfs_declaration_foreign,
};

interface StorageLfsPolicyRowProps {
  diagnostic: LfsPolicyDiagnostic | null;
  loading: boolean;
  error: boolean;
  updating: boolean;
  canUpdate: boolean;
  onUpdate: () => void;
  onRefresh: () => void;
}

// The repository LFS policy: whether it is current, which changed media it
// misses and, for S3, its LFS declaration.
export function StorageLfsPolicyRow({
  diagnostic,
  loading,
  error,
  updating,
  canUpdate,
  onUpdate,
  onRefresh,
}: StorageLfsPolicyRowProps) {
  const uncoveredCount =
    (diagnostic?.uncoveredPaths.length ?? 0) +
    (diagnostic?.truncatedCount ?? 0);
  const policyStale = diagnostic?.managedPolicyCurrent === false;
  const declaration = diagnostic?.lfsDeclaration ?? null;
  const declarationMissing = declaration === "missing";
  const attention =
    error || policyStale || uncoveredCount > 0 || declarationMissing;
  const status = error
    ? m.storage_lfs_policy_error_title()
    : policyStale
      ? m.storage_lfs_policy_update_title()
      : uncoveredCount > 0
        ? m.storage_lfs_policy_uncovered_title({
            count: String(uncoveredCount),
          })
        : declarationMissing
          ? m.storage_lfs_declaration_missing_title()
          : diagnostic
            ? m.storage_lfs_policy_ok()
            : m.storage_lfs_policy_checking();
  const visiblePaths =
    diagnostic?.uncoveredPaths.slice(0, VISIBLE_PATH_LIMIT) ?? [];
  const hiddenCount = Math.max(0, uncoveredCount - visiblePaths.length);

  return (
    <SettingsItem
      title={m.storage_lfs_policy_title()}
      description={
        <>
          <span className="block">{status}</span>
          {error ? (
            <span className="block">
              {m.storage_lfs_policy_error_description()}
            </span>
          ) : null}
          {policyStale ? (
            <span className="block">
              {m.storage_lfs_policy_update_description()}
            </span>
          ) : null}
          {declarationMissing ? (
            <span className="block">
              {m.storage_lfs_declaration_missing_description()}
            </span>
          ) : null}
          {uncoveredCount > 0 ? (
            <span className="block">
              {m.storage_lfs_policy_uncovered_description()}
            </span>
          ) : null}
          {declaration && !declarationMissing ? (
            <span className="block">
              {m.storage_lfs_declaration_status({
                state: DECLARATION_LABELS[declaration](),
              })}
            </span>
          ) : null}
        </>
      }
      actions={
        <>
          {attention ? (
            <Badge variant="destructive">
              {m.storage_lfs_policy_attention()}
            </Badge>
          ) : null}
          {policyStale || declarationMissing ? (
            <Button
              type="button"
              size="sm"
              onClick={onUpdate}
              disabled={!canUpdate || loading || updating}
            >
              {updating ? (
                <LoaderCircle
                  data-icon="inline-start"
                  className="animate-spin"
                />
              ) : null}
              {m.storage_lfs_policy_update_action()}
            </Button>
          ) : null}
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={onRefresh}
            disabled={loading || updating}
            aria-busy={loading || undefined}
          >
            <RefreshCw
              data-icon="inline-start"
              className={loading ? "animate-spin" : undefined}
            />
            {m.storage_lfs_policy_refresh_action()}
          </Button>
        </>
      }
    >
      {uncoveredCount > 0 ? (
        <div className="flex min-w-0 basis-full flex-col gap-1 rounded-md bg-muted/50 p-3 font-mono text-xs text-muted-foreground">
          {visiblePaths.map((path) => (
            <span key={path} className="break-all">
              {path}
            </span>
          ))}
          {hiddenCount > 0 ? (
            <span className="font-sans">
              {m.storage_lfs_policy_more({ count: String(hiddenCount) })}
            </span>
          ) : null}
        </div>
      ) : null}
    </SettingsItem>
  );
}
