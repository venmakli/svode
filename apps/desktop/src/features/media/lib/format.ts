import * as m from "@/paraglide/messages.js";

export function formatMediaBytes(value: number) {
  if (value < 1024) return `${value} B`;
  const units = ["KB", "MB", "GB", "TB"] as const;
  const exponent = Math.min(
    Math.floor(Math.log(value) / Math.log(1024)),
    units.length,
  );
  const scaled = value / 1024 ** exponent;
  const formatted =
    scaled < 10 && !Number.isInteger(scaled)
      ? scaled.toFixed(1).replace(/\.0$/u, "")
      : String(Math.round(scaled));
  return `${formatted} ${units[exponent - 1]}`;
}

export function formatMediaDuration(value: number) {
  if (!Number.isFinite(value) || value < 0)
    return m.media_metadata_unavailable();
  const totalSeconds = Math.floor(value);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
    : `${minutes}:${String(seconds).padStart(2, "0")}`;
}
