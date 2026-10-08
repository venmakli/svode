/**
 * Path forms of macOS, Windows and Linux. A network share is never a local
 * object: even a metadata read of its path reaches the server, so nothing
 * should look at it.
 */

/** `\\?\C:\…`: a drive path in the verbatim form a canonical one takes. */
const VERBATIM_DRIVE = /^[\\/]{2}\?[\\/](?=[a-z]:(?:[\\/]|$))/i;
const DRIVE_PATH = /^[a-z]:[\\/]/i;

/**
 * `\\server\share`, `//server/share`, `\\?\UNC\…`, `\\.\pipe\…`: two
 * leading separators of either kind, except a verbatim drive path.
 */
export function isNetworkPath(path: string): boolean {
  return /^[\\/]{2}/.test(path) && !VERBATIM_DRIVE.test(path);
}

/** A path of a Windows drive, `C:\…` or `C:/…`. */
export function isDrivePath(path: string): boolean {
  return DRIVE_PATH.test(path);
}

/** `\\?\C:\a` as `C:\a`; any other path as is. */
export function withoutVerbatimPrefix(path: string): string {
  return path.replace(VERBATIM_DRIVE, "");
}

/**
 * What two paths of one object share: a Windows drive path ignores the
 * case of ASCII letters and the kind of its separators, as Windows does.
 */
export function pathKey(path: string): string {
  const local = withoutVerbatimPrefix(path);
  if (!isDrivePath(local)) return local;
  return local
    .replace(/\\/g, "/")
    .replace(/[A-Z]/g, (letter) => letter.toLowerCase());
}
