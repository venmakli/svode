import { useCallback, useEffect, useRef, useState } from "react";
import { useRepositoryAccessPreflight } from "@/features/git";
import { useSpace } from "@/features/space";
import * as m from "@/paraglide/messages.js";
import { getSettingsSpaceConfig } from "../api";
import type { SaveSpaceConfig } from "./use-space-settings-config-actions";

interface UseSpaceSettingsGeneralOptions {
  open: boolean;
  spacePath: string;
  saveConfig: SaveSpaceConfig;
}

interface SpaceIdentity {
  name: string;
  description: string;
  icon: string;
}

const EMPTY_IDENTITY: SpaceIdentity = { name: "", description: "", icon: "" };

export function useSpaceSettingsGeneral({
  open,
  spacePath,
  saveConfig,
}: UseSpaceSettingsGeneralOptions) {
  const patchSpaceMetadata = useSpace((state) => state.patchSpaceMetadata);
  const recovery = useRepositoryAccessPreflight();
  const [draft, setDraftState] = useState(EMPTY_IDENTITY);
  const draftRef = useRef(EMPTY_IDENTITY);
  const savedRef = useRef(EMPTY_IDENTITY);
  // A write refused by repository access waits in the recovery; later edits
  // stay drafts until its explicit retry writes them all at once.
  const recoveringRef = useRef(false);
  const writesRef = useRef<Promise<void>>(Promise.resolve());
  const [retrying, setRetrying] = useState(false);
  const [status, setStatus] = useState<"loading" | "ready" | "error">(
    "loading",
  );

  const setDraft = useCallback((updates: Partial<SpaceIdentity>) => {
    draftRef.current = { ...draftRef.current, ...updates };
    setDraftState(draftRef.current);
  }, []);

  const loadGeneralConfig = useCallback(async () => {
    if (!spacePath) return;
    try {
      const cfg = await getSettingsSpaceConfig(spacePath);
      const identity = {
        name: cfg.name,
        description: cfg.description,
        icon: cfg.icon,
      };
      savedRef.current = identity;
      setDraft(identity);
      setStatus("ready");
    } catch (err) {
      console.error("Failed to load workspace config:", err);
      setStatus("error");
    }
  }, [setDraft, spacePath]);

  function retryGeneralConfig() {
    setStatus("loading");
    void loadGeneralConfig();
  }

  useEffect(() => {
    if (!open || !spacePath) return;
    const preload = window.setTimeout(() => {
      void loadGeneralConfig();
    }, 0);
    return () => window.clearTimeout(preload);
  }, [open, spacePath, loadGeneralConfig]);

  // Writes run one after another, each with every field not yet saved, so
  // the store and other surfaces only ever see what the config holds.
  function writeUnsaved() {
    const write = writesRef.current.then(async () => {
      const updates = unsavedIdentity(draftRef.current, savedRef.current);
      if (!updates) return;
      const result = await saveConfig(updates, (error) =>
        recovery.recoverFromError(error, {
          intentKey: `settings-general:${spacePath}`,
          intentLabel: m.settings_general_save_changes(),
          continuation: "explicit",
          placement: "inline",
          targets: [
            {
              displayName: savedRef.current.name,
              displayPath: spacePath,
              repositoryPath: spacePath,
            },
          ],
          continue: retryUnsaved,
        }),
      );
      if (result === "saved") {
        savedRef.current = { ...savedRef.current, ...updates };
        const current = draftRef.current;
        setDraft({
          ...(updates.name !== undefined && current.name.trim() === updates.name
            ? { name: updates.name }
            : {}),
          ...(updates.description !== undefined &&
          current.description.trim() === updates.description
            ? { description: updates.description }
            : {}),
        });
        patchSpaceMetadata(spacePath, updates);
      } else if (result === "recovering") {
        recoveringRef.current = true;
      } else if (
        updates.icon !== undefined &&
        draftRef.current.icon === updates.icon
      ) {
        setDraft({ icon: savedRef.current.icon });
      }
    });
    writesRef.current = write.catch(() => undefined);
    return write;
  }

  async function retryUnsaved() {
    recoveringRef.current = false;
    setRetrying(true);
    try {
      await writeUnsaved();
    } finally {
      setRetrying(false);
    }
  }

  async function commit() {
    if (!recoveringRef.current) await writeUnsaved();
  }

  async function handleIconChange(newIcon: string) {
    setDraft({ icon: newIcon });
    await commit();
  }

  return {
    status,
    retryGeneralConfig,
    name: draft.name,
    description: draft.description,
    icon: draft.icon,
    setName: (name: string) => setDraft({ name }),
    setDescription: (description: string) => setDraft({ description }),
    handleNameBlur: commit,
    handleDescriptionBlur: commit,
    handleIconChange,
    recovery,
    retrying,
  };
}

function unsavedIdentity(
  draft: SpaceIdentity,
  saved: SpaceIdentity,
): Partial<SpaceIdentity> | null {
  const updates: Partial<SpaceIdentity> = {};
  const name = draft.name.trim();
  if (name && name !== saved.name) updates.name = name;
  const description = draft.description.trim();
  if (description !== saved.description) updates.description = description;
  if (draft.icon !== saved.icon) updates.icon = draft.icon;
  return Object.keys(updates).length > 0 ? updates : null;
}
