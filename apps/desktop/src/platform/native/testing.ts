import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";

export function mockNativeIpc(
  handler: Parameters<typeof mockIPC>[0],
  options?: Parameters<typeof mockIPC>[1],
) {
  mockIPC(handler, options);
}

export function clearNativeMocks() {
  clearMocks();
}
