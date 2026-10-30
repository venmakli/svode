import { useState } from "react";
import { TriangleAlert } from "lucide-react";
import * as m from "@/paraglide/messages.js";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { spaceConfigResolver } from "../model/space-config-resolver";
import { useSpaceStore } from "../model/space-store";
import type { SpaceConfigUnreadable, SpaceInfo } from "../model/types";

/** The path of the config file inside its project or space. */
export const SPACE_CONFIG_PATH = ".svode/config.json";

export type SpaceConfigOwner = "project" | "space";

/** The title of a project or space whose config cannot be read. */
export function spaceConfigUnreadableTitle(owner: SpaceConfigOwner) {
  return owner === "project"
    ? m.space_config_unreadable_project_title()
    : m.space_config_unreadable_space_title();
}

function reasonText(owner: SpaceConfigOwner, reason: SpaceConfigUnreadable) {
  const file =
    owner === "project"
      ? m.space_config_file_project()
      : m.space_config_file_space();
  switch (reason.kind) {
    case "conflict":
      return m.space_config_unreadable_conflict({ file });
    case "notJson":
      return m.space_config_unreadable_not_json({ file });
    case "field":
      return reason.field
        ? m.space_config_unreadable_field({ file, field: reason.field })
        : m.space_config_unreadable_file({ file });
    case "access":
      return m.space_config_unreadable_access({ file });
  }
}

/**
 * The project or space is shown without its spaces and settings because its
 * config cannot be read. A file in conflict can be resolved in Changes; the
 * config is read again on request.
 */
export function SpaceConfigAlert({
  space,
  owner,
}: {
  space: SpaceInfo;
  owner: SpaceConfigOwner;
}) {
  const recheck = useSpaceStore((state) => state.recheckSpaceConfigs);
  const [checking, setChecking] = useState(false);
  const reason = space.configUnreadable;
  if (!reason) return null;
  const onResolve = spaceConfigResolver(space);
  return (
    <Alert>
      <TriangleAlert />
      <AlertTitle>{spaceConfigUnreadableTitle(owner)}</AlertTitle>
      <AlertDescription className="flex flex-col items-start gap-3">
        <span>
          {reasonText(owner, reason)}{" "}
          {owner === "project"
            ? m.space_config_unreadable_project_effect()
            : m.space_config_unreadable_space_effect()}
        </span>
        <div className="flex flex-wrap gap-2">
          {reason.kind === "conflict" && onResolve ? (
            <Button type="button" size="sm" onClick={onResolve}>
              {m.space_config_unreadable_resolve()}
            </Button>
          ) : null}
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={checking}
            aria-busy={checking || undefined}
            onClick={() => {
              setChecking(true);
              void recheck().finally(() => setChecking(false));
            }}
          >
            {m.space_config_unreadable_recheck()}
          </Button>
        </div>
      </AlertDescription>
    </Alert>
  );
}
