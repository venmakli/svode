import { useCallback, useEffect, useRef } from "react";
import type {
  AgentSessionKeyDto,
  AgentSessionSnapshotDto,
  AgentSettingValueDto,
} from "../api/chat";
import type { ComposerDraft } from "../model/composer";
import { draftValuesToApply, withDraftValue } from "../model/session-controls";
import { useSessionSettings } from "./use-session-settings";

type UpdateDraft = (change: (draft: ComposerDraft) => ComposerDraft) => void;

/** The values a draft keeps for `agent`. */
export function draftValues(
  draft: ComposerDraft,
  agent: string | null,
): AgentSettingValueDto[] {
  return agent && draft.settings?.agent === agent ? draft.settings.values : [];
}

/**
 * The settings of a new session draft (Stage 10 `04`, selectors): a change
 * goes to the draft's session and the draft keeps the value once the agent
 * confirmed it. A draft session created anew, as after a reload, gets the
 * kept values again; one it does not offer is dropped with its reason and
 * never replaced silently.
 */
export function useDraftSettings(
  agent: string | null,
  draftSession: AgentSessionKeyDto | null,
  snapshot: AgentSessionSnapshotDto | null,
  draft: ComposerDraft,
  updateDraft: UpdateDraft,
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
    const { apply, undeclared } = draftValuesToApply(
      draftValues(draft, agent),
      snapshot.settings,
    );
    const drop = (dropped: AgentSettingValueDto[]) =>
      updateDraft((latest) => ({
        ...latest,
        settings: {
          agent,
          values: draftValues(latest, agent).filter(
            (value) =>
              !dropped.some(
                (gone) =>
                  gone.setting === value.setting && gone.value === value.value,
              ),
          ),
        },
      }));
    if (undeclared.length > 0) {
      drop(undeclared);
      refuse({ ...undeclared[0], reason: { kind: "not_declared" } });
    }
    void (async () => {
      for (const value of apply) {
        if (!(await change(value))) drop([value]);
      }
    })();
  }, [agent, change, draft, draftSession, refuse, snapshot, updateDraft]);

  const changeSetting = useCallback(
    async (value: AgentSettingValueDto) => {
      if (!agent || !(await change(value))) return;
      updateDraft((latest) => ({
        ...latest,
        settings: {
          agent,
          values: withDraftValue(draftValues(latest, agent), value),
        },
      }));
    },
    [agent, change, updateDraft],
  );

  return { ...settings, changeSetting };
}
