import {
  CheckCircle2,
  CircleHelp,
  LoaderCircle,
  LockKeyhole,
  RefreshCw,
  type LucideIcon,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import * as m from "@/paraglide/messages.js";

import type {
  RepositoryAccessReason,
  RepositoryAccessSnapshot,
  RepositoryAccessStatus,
} from "../model/repository-access";

const EMPTY_ACCESS: RepositoryAccessSnapshot = {
  checkedAt: null,
  expiresAt: null,
  generation: 0,
  lastKnownStatus: null,
  reason: "not_checked",
  repositoryId: "unresolved",
  status: "unknown",
};

export function RepositoryAccessHeader({
  error = null,
  onVerify,
  snapshot,
  verifying = false,
}: {
  error?: string | null;
  onVerify(): void;
  snapshot: RepositoryAccessSnapshot | null;
  verifying?: boolean;
}) {
  const access = snapshot ?? EMPTY_ACCESS;
  const status = verifying ? "checking" : access.status;
  const presentation = statusPresentation(status);
  const Icon = presentation.icon;
  const description = error
    ? m.actors_access_load_error()
    : statusDescription(status, access.reason);

  return (
    <div
      className="flex min-h-11 shrink-0 items-center justify-between gap-3 border-b px-6 py-2"
      data-repository-access-header
      data-repository-access-status={status}
    >
      <div className="flex min-w-0 items-center gap-2.5">
        <Badge variant={presentation.variant}>
          <Icon
            data-icon="inline-start"
            className={status === "checking" ? "animate-spin" : undefined}
          />
          {presentation.label}
        </Badge>
        <span
          className="truncate text-xs text-muted-foreground"
          title={error ?? description}
        >
          {description}
        </span>
      </div>
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={status === "checking"}
        onClick={onVerify}
      >
        <RefreshCw
          data-icon="inline-start"
          className={status === "checking" ? "animate-spin" : undefined}
        />
        {m.actors_access_check()}
      </Button>
    </div>
  );
}

function statusPresentation(status: RepositoryAccessStatus): {
  icon: LucideIcon;
  label: string;
  variant: "outline" | "secondary";
} {
  switch (status) {
    case "local":
    case "writable":
      return {
        icon: CheckCircle2,
        label: m.actors_access_status_editing(),
        variant: "outline",
      };
    case "checking":
      return {
        icon: LoaderCircle,
        label: m.actors_access_status_checking(),
        variant: "secondary",
      };
    case "read_only":
      return {
        icon: LockKeyhole,
        label: m.actors_access_status_read_only(),
        variant: "secondary",
      };
    case "unknown":
      return {
        icon: CircleHelp,
        label: m.actors_access_status_unknown(),
        variant: "outline",
      };
  }
}

function statusDescription(
  status: RepositoryAccessStatus,
  reason: RepositoryAccessReason | null,
) {
  switch (status) {
    case "local":
      return m.actors_access_description_local();
    case "writable":
      return m.actors_access_description_writable();
    case "read_only":
      return m.actors_access_description_read_only();
    case "checking":
      return m.actors_access_description_checking();
    case "unknown":
      return reasonDescription(reason);
  }
}

function reasonDescription(reason: RepositoryAccessReason | null) {
  switch (reason) {
    case "auth_required":
      return m.actors_access_reason_auth_required();
    case "offline_or_timeout":
      return m.actors_access_reason_offline_or_timeout();
    case "unsupported_ref":
      return m.actors_access_reason_unsupported_ref();
    case "unsupported_remote_configuration":
      return m.actors_access_reason_unsupported_remote_configuration();
    case "ambiguous_rejection":
      return m.actors_access_reason_ambiguous_rejection();
    case "lease_conflict":
      return m.actors_access_reason_lease_conflict();
    case "expired":
      return m.actors_access_reason_expired();
    case "remote_changed":
      return m.actors_access_reason_remote_changed();
    case "not_checked":
    case null:
      return m.actors_access_reason_not_checked();
  }
}
