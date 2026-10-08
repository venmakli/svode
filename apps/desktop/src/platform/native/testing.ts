import { clearMocks, mockIPC, mockWindows } from "@tauri-apps/api/mocks";

export function mockNativeIpc(
  handler: Parameters<typeof mockIPC>[0],
  options?: Parameters<typeof mockIPC>[1],
) {
  mockIPC(handler, options);
}

export function clearNativeMocks() {
  clearMocks();
}

/** The current window and webview, for code that listens to window events. */
export function mockNativeWindow(label = "main") {
  mockWindows(label);
}
