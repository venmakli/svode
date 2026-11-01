import { useCallback, useEffect, useRef } from "react";
import type {
  AgentSessionKeyDto,
  AgentSessionSnapshotDto,
  AgentSettingValueDto,
} from "../api/chat";
import { draftValuesToApply, withDraftValue } from "../model/session-controls";
import { useSessionSettings } from "./use-session-settings";

/** Changes the kept values; `change` gets the latest ones. */
export type UpdateKeptValues = (
  change: (values: AgentSettingValueDto[]) => AgentSettingValueDto[],
) => void;

/**
 * The settings of a draft session (Stage 10 `04`, selectors): a change goes
 * to the draft's session and the host keeps the value once the agent
 * confirmed it. A draft session created anew, as after a reload, gets the
 * kept values again; one it does not offer is dropped with its reason and
 * never replaced silently.
 */
export function useDraftSettings(
  agent: string | null,
  draftSession: AgentSessionKeyDto | null,
  snapshot: AgentSessionSnapshotDto | null,
  values: AgentSettingValueDto[],
  updateValues: UpdateKeptValues,
) {
  const settings = useSessionSettings(draftSession);
  const { change, refuse } = settings;

  const restored = useRef<AgentSessionKeyDto | null>(null);
  useEffect(() => {
    if (
      !agent ||
      !draftSession ||
      !snapshot ||
      restored.current === draftSession
    ) {
      return;
    }
    restored.current = draftSession;
    const { apply, undeclared } = draftValuesToApply(values, snapshot.settings);
    const drop = (dropped: AgentSettingValueDto[]) =>
      updateValues((latest) =>
        latest.filter(
          (value) =>
            !dropped.some(
              (gone) =>
                gone.setting === value.setting && gone.value === value.value,
            ),
        ),
      );
    if (undeclared.length > 0) {
      drop(undeclared);
      refuse({ ...undeclared[0], reason: { kind: "not_declared" } });
    }
    void (async () => {
      for (const value of apply) {
        if (!(await change(value))) drop([value]);
      }
    })();
  }, [agent, change, draftSession, refuse, snapshot, updateValues, values]);

  const changeSetting = useCallback(
    async (value: AgentSettingValueDto) => {
      if (!agent || !(await change(value))) return;
      updateValues((latest) => withDraftValue(latest, value));
    },
    [agent, change, updateValues],
  );

  return { ...settings, changeSetting };
}
