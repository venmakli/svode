import { useEffect, useState } from "react";
import { getSecretStore } from "../api";

// Path of the secrets file while it is the device store of Secret values,
// otherwise null. Read again when the window regains focus, since the store
// is switched from the CLI.
export function useSecretStoreFile(): string | null {
  const [file, setFile] = useState<string | null>(null);
  useEffect(() => {
    let disposed = false;
    const refresh = () => {
      getSecretStore()
        .then((store) => {
          if (!disposed) setFile(store.kind === "file" ? store.file : null);
        })
        .catch((error) => {
          console.error("get_secret_store failed:", error);
        });
    };
    refresh();
    window.addEventListener("focus", refresh);
    return () => {
      disposed = true;
      window.removeEventListener("focus", refresh);
    };
  }, []);
  return file;
}
