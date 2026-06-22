export function getRootProjectErrorDescription(
  err: unknown,
): string | undefined {
  const message =
    typeof err === "string"
      ? err
      : err instanceof Error
        ? err.message
        : err && typeof err === "object" && "message" in err
          ? String((err as { message: unknown }).message)
          : "";

  return message.trim() || undefined;
}
