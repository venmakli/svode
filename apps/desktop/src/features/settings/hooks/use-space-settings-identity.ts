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
  const [fanoutEnabled, setFanoutEnabled] = useState(true);
  const [fanoutPreview, setFanoutPreview] = useState<FanoutPreviewEntry[]>([]);
  const [fanoutSelected, setFanoutSelected] = useState<Record<string, boolean>>(
    {},
  );

  const loadIdentity = useCallback(async () => {
    if (!spacePath) return;
    try {
      const result = await getRepoIdentity(spacePath);
      setRepoIdentity(result);
      setIdentityName(result.local?.name ?? "");
      setIdentityEmail(result.local?.email ?? "");
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
    setFanoutEnabled(true);
  }, [open, spacePath, loadIdentity, loadFanoutPreview]);

  async function handleSaveIdentity() {
    if (!spacePath) return;
    const trimmedName = identityName.trim();
    const trimmedEmail = identityEmail.trim();
    const bothEmpty = !trimmedName && !trimmedEmail;
    const bothFilled = trimmedName && trimmedEmail;
    if (!bothEmpty && !bothFilled) {
      setIdentityFormError(m.settings_git_identity_both_required());
      return;
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
      return;
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
    } catch (err) {
      console.error("identity save failed:", err);
      toast.error(m.toast_error());
    } finally {
      setSavingIdentity(false);
    }
  }

  return {
    repoIdentity,
    identityName,
    identityEmail,
    identityFormError,
    savingIdentity,
    fanoutEnabled,
    fanoutPreview,
    fanoutSelected,
    setIdentityName,
    setIdentityEmail,
    setFanoutEnabled,
    setFanoutSelected,
    handleSaveIdentity,
  };
}
