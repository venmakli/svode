import * as m from "@/paraglide/messages.js";

/** The label of showing an item in the file manager of this OS. */
export function revealInFileManagerLabel(): string {
  const platform =
    typeof navigator === "undefined" ? "" : navigator.platform.toLowerCase();
  if (platform.includes("mac")) return m.external_open_reveal_finder();
  if (platform.includes("win")) return m.external_open_reveal_explorer();
  return m.external_open_reveal_file_manager();
}
