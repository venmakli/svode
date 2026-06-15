export interface NativeCommandError {
  message: string;
  cause: unknown;
}

export function getNativeErrorMessage(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message: unknown }).message;
    if (typeof message === "string") return message;
  }
  return String(error);
}

export function toNativeCommandError(error: unknown): NativeCommandError {
  return {
    message: getNativeErrorMessage(error),
    cause: error,
  };
}
