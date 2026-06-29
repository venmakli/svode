import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import * as m from "@/paraglide/messages.js";
import {
  isValidEmail,
  isValidName,
  useIdentityRefreshNotifier,
  type FanoutPreviewEntry,
  type RepoIdentityResult,
} from "@/features/identity";
import {
  getProjectFanoutPreview,
  getRepoIdentity,
  saveProjectIdentity,
  saveRepoIdentity,
} from "../api";
import {
  identityDraftFromRepoIdentity,
  repoIdentityHasOverride,
} from "../model";

interface UseSpaceSettingsIdentityOptions {
  open: boolean;
  spacePath: string;
  isRoot: boolean;
}

export function useSpaceSettingsIdentity({
  open,
  spacePath,
  isRoot,
}: UseSpaceSettingsIdentityOptions) {
  const bumpIdentityVersion = useIdentityRefreshNotifier();
  const [repoIdentity, setRepoIdentity] = useState<RepoIdentityResult | null>(
    null,
  );
  const [identityName, setIdentityName] = useState("");
  const [identityEmail, setIdentityEmail] = useState("");
  const [savingIdentity, setSavingIdentity] = useState(false);
  const [identityFormError, setIdentityFormError] = useState<string | null>(
    null,
  );
  const [identityEditing, setIdentityEditing] = useState(false);
  const [fanoutEnabled, setFanoutEnabled] = useState(false);
  const [fanoutPreview, setFanoutPreview] = useState<FanoutPreviewEntry[]>([]);
  const [fanoutSelected, setFanoutSelected] = useState<Record<string, boolean>>(
    {},
  );

  const loadIdentity = useCallback(async () => {
    if (!spacePath) return;
    try {
      const result = await getRepoIdentity(spacePath);
      setRepoIdentity(result);
      const draft = identityDraftFromRepoIdentity(result);
      setIdentityName(draft.name);
      setIdentityEmail(draft.email);
      setIdentityFormError(null);
    } catch (err) {
      console.warn("get_repo_identity failed:", err);
      setRepoIdentity(null);
    }
  }, [spacePath]);

  const loadFanoutPreview = useCallback(async () => {
    if (!isRoot || !spacePath) {
      setFanoutPreview([]);
      setFanoutSelected({});
      return;
    }
    try {
      const list = await getProjectFanoutPreview(spacePath);
      setFanoutPreview(list);
      const initial: Record<string, boolean> = {};
      for (const entry of list) initial[entry.spacePath] = true;
      setFanoutSelected(initial);
    } catch (err) {
      console.warn("get_project_fanout_preview failed:", err);
      setFanoutPreview([]);
      setFanoutSelected({});
    }
  }, [isRoot, spacePath]);

  useEffect(() => {
    if (!open || !spacePath) return;
    void loadIdentity();
    void loadFanoutPreview();
    setIdentityEditing(false);
    setFanoutEnabled(false);
  }, [open, spacePath, loadIdentity, loadFanoutPreview]);

  function handleStartIdentityEdit() {
    const draft = identityDraftFromRepoIdentity(repoIdentity);
    setIdentityName(draft.name);
    setIdentityEmail(draft.email);
    setIdentityFormError(null);
    setIdentityEditing(true);
  }

  function handleCancelIdentityEdit() {
    const draft = identityDraftFromRepoIdentity(repoIdentity);
    setIdentityName(draft.name);
    setIdentityEmail(draft.email);
    setIdentityFormError(null);
    setIdentityEditing(false);
    setFanoutEnabled(false);
  }

  async function persistIdentityDraft(name: string, email: string) {
    if (!spacePath) return;
    const trimmedName = name.trim();
    const trimmedEmail = email.trim();
    const bothEmpty = !trimmedName && !trimmedEmail;
    const bothFilled = trimmedName && trimmedEmail;
    if (!bothEmpty && !bothFilled) {
      setIdentityFormError(m.settings_git_identity_both_required());
      return false;
    }
    if (
      bothEmpty &&
      !repoIdentity?.effective &&
      !repoIdentityHasOverride(repoIdentity)
    ) {
      setIdentityFormError(m.settings_git_identity_missing_save_error());
      return false;
    }
    if (
      bothFilled &&
      (!isValidName(trimmedName) || !isValidEmail(trimmedEmail))
    ) {
      setIdentityFormError(
        !isValidName(trimmedName)
          ? m.identity_name_empty()
          : m.identity_email_invalid(),
      );
      return false;
    }

    setIdentityFormError(null);
    setSavingIdentity(true);
    try {
      if (isRoot) {
        const targets = fanoutEnabled
          ? fanoutPreview
              .filter((entry) => fanoutSelected[entry.spacePath])
              .map((entry) => entry.spacePath)
          : [];
        await saveProjectIdentity({
          rootPath: spacePath,
          name: bothFilled ? trimmedName : null,
          email: bothFilled ? trimmedEmail : null,
          targetSpaces: targets,
        });
      } else {
        await saveRepoIdentity({
          repoPath: spacePath,
          name: bothFilled ? trimmedName : null,
          email: bothFilled ? trimmedEmail : null,
        });
      }
      await loadIdentity();
      await loadFanoutPreview();
      bumpIdentityVersion();
      toast.success(m.toast_settings_saved());
      return true;
    } catch (err) {
      console.error("identity save failed:", err);
      toast.error(m.toast_error());
      return false;
    } finally {
      setSavingIdentity(false);
    }
  }

  async function handleSaveIdentity() {
    const saved = await persistIdentityDraft(identityName, identityEmail);
    if (saved) {
      setIdentityEditing(false);
      setFanoutEnabled(false);
    }
  }

  async function handleResetIdentity() {
    setIdentityName("");
    setIdentityEmail("");
    const saved = await persistIdentityDraft("", "");
    if (saved) {
      setIdentityEditing(false);
      setFanoutEnabled(false);
    }
  }

  return {
    repoIdentity,
    identityName,
    identityEmail,
    identityFormError,
    savingIdentity,
    identityEditing,
    canResetIdentity: repoIdentityHasOverride(repoIdentity),
    fanoutEnabled,
    fanoutPreview,
    fanoutSelected,
    setIdentityName,
    setIdentityEmail,
    handleStartIdentityEdit,
    handleCancelIdentityEdit,
    setFanoutEnabled,
    setFanoutSelected,
    handleSaveIdentity,
    handleResetIdentity,
  };
}
