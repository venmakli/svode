import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import * as m from "@/paraglide/messages.js";
import {
  isValidEmail,
  isValidName,
  useGlobalIdentity,
  useGlobalIdentityFingerprint,
  useSaveGlobalIdentity,
} from "@/features/identity";

interface IdentityFormState {
  name: string;
  email: string;
  baselineName: string;
  baselineEmail: string;
  baselineFingerprint: string | null;
  stale: boolean;
}

const EMPTY_FORM: IdentityFormState = {
  name: "",
  email: "",
  baselineName: "",
  baselineEmail: "",
  baselineFingerprint: null,
  stale: false,
};

export function useGlobalIdentitySettings(open: boolean) {
  const identityGlobal = useGlobalIdentity();
  const identityFingerprint = useGlobalIdentityFingerprint();
  const saveGlobalIdentity = useSaveGlobalIdentity();
  const [form, setForm] = useState<IdentityFormState>(EMPTY_FORM);
  const [savingIdentity, setSavingIdentity] = useState(false);
  const wasOpenRef = useRef(false);

  useEffect(() => {
    if (!open) {
      wasOpenRef.current = false;
      return;
    }

    const justOpened = !wasOpenRef.current;
    wasOpenRef.current = true;
    const canonicalName = identityGlobal?.name ?? "";
    const canonicalEmail = identityGlobal?.email ?? "";

    setForm((current) => {
      if (justOpened || current.baselineFingerprint === null) {
        return identityFormFromCanonical(
          canonicalName,
          canonicalEmail,
          identityFingerprint,
        );
      }
      if (current.baselineFingerprint === identityFingerprint) return current;
      if (isDirtyIdentityForm(current)) {
        return current.stale ? current : { ...current, stale: true };
      }
      return identityFormFromCanonical(
        canonicalName,
        canonicalEmail,
        identityFingerprint,
      );
    });
  }, [identityFingerprint, identityGlobal, open]);

  const setIdentityName = useCallback((name: string) => {
    setForm((current) => ({ ...current, name }));
  }, []);
  const setIdentityEmail = useCallback((email: string) => {
    setForm((current) => ({ ...current, email }));
  }, []);

  const identityNameValid = isValidName(form.name);
  const identityEmailValid = isValidEmail(form.email);
  const identityChanged = isDirtyIdentityForm(form);
  const canSaveIdentity =
    identityNameValid &&
    identityEmailValid &&
    identityChanged &&
    !form.stale &&
    form.baselineFingerprint !== null &&
    !savingIdentity;

  const handleSaveIdentity = useCallback(async () => {
    if (!canSaveIdentity || form.baselineFingerprint === null) return;
    setSavingIdentity(true);
    try {
      const mutation = await saveGlobalIdentity(
        form.name.trim(),
        form.email.trim(),
        form.baselineFingerprint,
      );
      if (mutation.status === "conflict") {
        setForm((current) => ({ ...current, stale: true }));
        return;
      }
      setForm(
        identityFormFromCanonical(
          mutation.canonical.global?.name ?? "",
          mutation.canonical.global?.email ?? "",
          mutation.canonical.fingerprint,
        ),
      );
      toast.success(m.toast_settings_saved());
    } catch (err) {
      console.error("set_git_identity failed:", err);
      toast.error(m.toast_error());
    } finally {
      setSavingIdentity(false);
    }
  }, [canSaveIdentity, form, saveGlobalIdentity]);

  const handleUseLatestIdentity = useCallback(() => {
    setForm(
      identityFormFromCanonical(
        identityGlobal?.name ?? "",
        identityGlobal?.email ?? "",
        identityFingerprint,
      ),
    );
  }, [identityFingerprint, identityGlobal]);

  const handleKeepIdentityDraft = useCallback(() => {
    setForm((current) => ({
      ...current,
      baselineName: identityGlobal?.name ?? "",
      baselineEmail: identityGlobal?.email ?? "",
      baselineFingerprint: identityFingerprint,
      stale: false,
    }));
  }, [identityFingerprint, identityGlobal]);

  return {
    identityName: form.name,
    setIdentityName,
    identityEmail: form.email,
    setIdentityEmail,
    identityNameValid,
    identityEmailValid,
    identityStale: form.stale,
    savingIdentity,
    canSaveIdentity,
    handleKeepIdentityDraft,
    handleSaveIdentity,
    handleUseLatestIdentity,
  };
}

function identityFormFromCanonical(
  name: string,
  email: string,
  fingerprint: string,
): IdentityFormState {
  return {
    name,
    email,
    baselineName: name,
    baselineEmail: email,
    baselineFingerprint: fingerprint,
    stale: false,
  };
}

function isDirtyIdentityForm(form: IdentityFormState): boolean {
  return (
    form.name.trim() !== form.baselineName ||
    form.email.trim() !== form.baselineEmail
  );
}
