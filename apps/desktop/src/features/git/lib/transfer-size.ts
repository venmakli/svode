import { getLocale } from "@/paraglide/runtime.js";

const MEBIBYTE = 1024 * 1024;

/**
 * Megabytes of a transferred file for its copy: one decimal below 10, whole
 * above, so a 95 MiB video reads "95" and a photo "0.3".
 */
export function transferMegabytes(bytes: number): string {
  const megabytes = bytes / MEBIBYTE;
  return new Intl.NumberFormat(getLocale(), {
    maximumFractionDigits: megabytes < 10 ? 1 : 0,
  }).format(megabytes);
}
