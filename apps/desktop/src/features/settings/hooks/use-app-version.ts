import { useState, useEffect } from "react";
import { getAppVersion } from "@/platform/native/app";

export function useAppVersion() {
  const [version, setVersion] = useState<string>("");

  useEffect(() => {
    getAppVersion().then(setVersion);
  }, []);

  return version;
}
