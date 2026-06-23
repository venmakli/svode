import { invokeCommand as invoke } from "@/platform/native/invoke";
import type { EntryDetailState } from "../model";

export function getEntryDetailState({
  spacePath,
  path,
}: {
  spacePath: string;
  path: string;
}) {
  return invoke<EntryDetailState>("get_entry_detail_state", {
    space: spacePath,
    path,
  });
}
