import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import * as m from "@/paraglide/messages.js";
import {
  isValidEmail,
  isValidName,
  useGlobalIdentity,
  useSaveGlobalIdentity,
} from "@/features/identity";

export function useGlobalIdentitySettings(open: boolean) {
  const identityGlobal = useGlobalIdentity();
  const saveGlobalIdentity = useSaveGlobalIdentity();
  const [identityName, setIdentityName] = useState("");
  const [identityEmail, setIdentityEmail] = useState("");
  const [savingIdentity, setSavingIdentity] = useState(false);

  useEffect(() => {
    if (!open) return;
    setIdentityName(identityGlobal?.name ?? "");
    setIdentityEmail(identityGlobal?.email ?? "");
  }, [open, identityGlobal]);

  const identityNameValid = isValidName(identityName);
  const identityEmailValid = isValidEmail(identityEmail);
  const identityChanged =
    identityName.trim() !== (identityGlobal?.name ?? "") ||
    identityEmail.trim() !== (identityGlobal?.email ?? "");
  const canSaveIdentity =
    identityNameValid &&
    identityEmailValid &&
    identityChanged &&
    !savingIdentity;

  const handleSaveIdentity = useCallback(async () => {
    if (!canSaveIdentity) return;
    setSavingIdentity(true);
    try {
      await saveGlobalIdentity(identityName.trim(), identityEmail.trim());
      toast.success(m.toast_settings_saved());
    } catch (err) {
      console.error("set_git_identity failed:", err);
      toast.error(m.toast_error());
    } finally {
      setSavingIdentity(false);
    }
  }, [canSaveIdentity, identityEmail, identityName, saveGlobalIdentity]);

  return {
    identityName,
    setIdentityName,
    identityEmail,
    setIdentityEmail,
    identityNameValid,
    identityEmailValid,
    canSaveIdentity,
    handleSaveIdentity,
  };
}
