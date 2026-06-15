const MINUTE = 60;
const HOUR = 3600;
const DAY = 86400;
const WEEK = 604800;
const MONTH = 2592000;
const YEAR = 31536000;

/**
 * Returns a human-readable relative time string (e.g. "2 hours ago").
 * Uses Intl.RelativeTimeFormat for locale-aware formatting.
 */
export function relativeTime(dateStr: string, locale = "en"): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffSeconds = Math.round((date.getTime() - now.getTime()) / 1000);
  const absDiff = Math.abs(diffSeconds);

  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });

  if (absDiff < MINUTE) {
    return rtf.format(diffSeconds, "second");
  } else if (absDiff < HOUR) {
    return rtf.format(Math.round(diffSeconds / MINUTE), "minute");
  } else if (absDiff < DAY) {
    return rtf.format(Math.round(diffSeconds / HOUR), "hour");
  } else if (absDiff < WEEK) {
    return rtf.format(Math.round(diffSeconds / DAY), "day");
  } else if (absDiff < MONTH) {
    return rtf.format(Math.round(diffSeconds / WEEK), "week");
  } else if (absDiff < YEAR) {
    return rtf.format(Math.round(diffSeconds / MONTH), "month");
  } else {
    return rtf.format(Math.round(diffSeconds / YEAR), "year");
  }
}
