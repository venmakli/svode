import * as m from "@/paraglide/messages.js";

/** A turn's duration: seconds, minutes with seconds, or hours with minutes. */
export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return m.sessions_chat_duration_seconds({ seconds });
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return m.sessions_chat_duration_minutes({
      minutes,
      seconds: seconds % 60,
    });
  }
  return m.sessions_chat_duration_hours({
    hours: Math.floor(minutes / 60),
    minutes: minutes % 60,
  });
}
