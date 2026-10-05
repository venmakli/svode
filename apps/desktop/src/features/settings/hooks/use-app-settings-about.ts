import { useEffect, useState } from "react";
import { getBuildCommit } from "@/platform/build-info";
import { listSpeechModelLicenses, type SpeechModelLicenseDto } from "../api";
import { useAppVersion } from "./use-app-version";

const RELEASE_URL = "https://github.com/venmakli/svode/releases";

export function useAppSettingsAbout() {
  const version = useAppVersion();
  const buildCommit = getBuildCommit();
  const [speechModelLicenses, setSpeechModelLicenses] = useState<
    SpeechModelLicenseDto[]
  >([]);

  useEffect(() => {
    let active = true;
    void listSpeechModelLicenses().then((licenses) => {
      if (active) setSpeechModelLicenses(licenses);
    });
    return () => {
      active = false;
    };
  }, []);

  return {
    version,
    buildCommit,
    releaseUrl: RELEASE_URL,
    speechModelLicenses,
  };
}
