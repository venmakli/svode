import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";

export function mockNativeIpc(handler: Parameters<typeof mockIPC>[0]) {
  mockIPC(handler);
}

export function clearNativeMocks() {
  clearMocks();
}
