import { openPath } from "@/platform/native/shell";

export function copyPropertyValue(value: string) {
  if (!value) return;
  void navigator.clipboard?.writeText(value);
}

export function openPropertyExternal(value: string) {
  if (!value) return;
  void openPath(value);
}
