import { useMemo, useState } from "react";
import * as m from "@/paraglide/messages.js";

import { saveGitRemoteCredentials } from "../api/git-actions";
import {
  gitAuthChallengeFromRemoteUrl,
  type GitRemoteAuthCredentials,
} from "../model";
import type {
  RepositoryAccessPrimaryAction,
  RepositoryAccessSnapshot,
} from "../model/repository-access";

interface UseRepositoryAccessRecoveryOptions {
  remoteUrl: string;
  verify(): Promise<RepositoryAccessSnapshot | null>;
  onEditRemote(): void;
}

export function useRepositoryAccessRecovery({
  remoteUrl,
  verify,
  onEditRemote,
}: UseRepositoryAccessRecoveryOptions) {
  const [authOpen, setAuthOpen] = useState(false);
  const [authSaving, setAuthSaving] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [recommendationsOpen, setRecommendationsOpen] = useState(false);
  const challenge = useMemo(
    () =>
      remoteUrl.trim()
        ? gitAuthChallengeFromRemoteUrl({
            remoteUrl,
            operation: "unknown",
            detail: null,
          })
        : null,
    [remoteUrl],
  );

  function runPrimaryAction(action: RepositoryAccessPrimaryAction) {
    switch (action) {
      case "verify":
        void verify();
        break;
      case "authenticate":
        if (!challenge) {
          onEditRemote();
          return;
        }
        setAuthError(null);
        setAuthOpen(true);
        break;
      case "edit_remote":
        onEditRemote();
        break;
      case "recommendations":
        setRecommendationsOpen(true);
        break;
      case "none":
        break;
    }
  }

  async function saveAuthAndVerify(credentials: GitRemoteAuthCredentials) {
    if (!challenge?.remoteUrl || authSaving) return;
    setAuthSaving(true);
    setAuthError(null);
    try {
      await saveGitRemoteCredentials({
        remoteUrl: challenge.remoteUrl,
        username: credentials.username,
        password: credentials.password,
      });
      const snapshot = await verify();
      if (snapshot?.status === "local" || snapshot?.status === "writable") {
        setAuthOpen(false);
        return;
      }
      setAuthError(m.git_access_auth_still_blocked());
    } catch (error) {
      console.error("repository access credential recovery failed:", error);
      setAuthError(m.git_remote_auth_save_failed());
    } finally {
      setAuthSaving(false);
    }
  }

  function handleAuthOpenChange(open: boolean) {
    setAuthOpen(open);
    if (!open) setAuthError(null);
  }

  return {
    authError,
    authOpen,
    authSaving,
    challenge,
    recommendationsOpen,
    handleAuthOpenChange,
    runPrimaryAction,
    saveAuthAndVerify,
  };
}
