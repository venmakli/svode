import * as m from "@/paraglide/messages.js";
import { useSecretStoreFile } from "../hooks/use-secret-store-file";

const PATH = "\u0000path\u0000";

// The line under a Variables page description while Secret values are in the
// secrets file: only its path, never values or their number. Phrasing
// content, so it can sit inside the description paragraph.
export function SecretStoreFileNote() {
  const file = useSecretStoreFile();
  if (!file) return null;
  const [before, after = ""] = m
    .variables_secret_store_file({ path: PATH })
    .split(PATH);
  return (
    <span className="block">
      {before}
      <code className="font-mono break-all select-text">{file}</code>
      {after}
    </span>
  );
}
