import { expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { clearNativeMocks, mockNativeIpc } from "@/platform/native/testing";

import { useIdentityStore } from "./identity-store";
import type { GlobalIdentityResult } from "./types";

test("bootstraps canonical identity, keeps the latest read, and deduplicates equal snapshots", async () => {
  const restore = installTestWindow();
  const staleRead = deferred<GlobalIdentityResult>();
  let readCount = 0;
  mockNativeIpc((command) => {
    if (command !== "get_git_identity") {
      throw new Error(`Unexpected command: ${command}`);
    }
    readCount += 1;
    if (readCount === 1) return identity("Alice", "alice@example.test", "v1");
    if (readCount === 2) return staleRead.promise;
    return identity("Bob", "bob@example.test", "v2");
  });

  try {
    await useIdentityStore.getState().load();
    expect(useIdentityStore.getState().global?.name).toBe("Alice");
    expect(useIdentityStore.getState().refreshVersion).toBe(1);

    const stalePromise = useIdentityStore.getState().load();
    const freshPromise = useIdentityStore.getState().load();
    await freshPromise;
    staleRead.resolve(identity("Alice", "alice@example.test", "v1"));
    await stalePromise;

    expect(useIdentityStore.getState().global?.name).toBe("Bob");
    expect(useIdentityStore.getState().refreshVersion).toBe(2);

    await useIdentityStore.getState().load();
    expect(useIdentityStore.getState().refreshVersion).toBe(2);
  } finally {
    restore();
  }
});

test("sends the expected fingerprint and adopts canonical conflict recovery", async () => {
  const restore = installTestWindow();
  resetIdentityStore(identity("Alice", "alice@example.test", "v1"));
  const mutationCalls: Record<string, unknown>[] = [];
  mockNativeIpc((command, args) => {
    if (command === "set_git_identity") {
      mutationCalls.push(args as Record<string, unknown>);
      return {
        status: "conflict",
        canonical: identity("Bob", "bob@example.test", "v2"),
      };
    }
    if (command === "get_git_identity") {
      return identity("Bob", "bob@example.test", "v2");
    }
    throw new Error(`Unexpected command: ${command}`);
  });

  try {
    const mutation = await useIdentityStore
      .getState()
      .saveGlobal("Draft", "draft@example.test", "v1");

    expect(mutation.status).toBe("conflict");
    expect(mutationCalls[0]?.expectedFingerprint).toBe("v1");
    expect(useIdentityStore.getState().global?.name).toBe("Bob");
    expect(useIdentityStore.getState().fingerprint).toBe("v2");
  } finally {
    restore();
  }
});

test("re-reads actual canonical identity after a partial save failure", async () => {
  const restore = installTestWindow();
  resetIdentityStore(identity("Alice", "alice@example.test", "v1"));
  mockNativeIpc((command) => {
    if (command === "set_git_identity") {
      throw new Error("email write failed");
    }
    if (command === "get_git_identity") {
      return identity("Alice", "alice@example.test", "v1");
    }
    throw new Error(`Unexpected command: ${command}`);
  });

  try {
    let errorMessage = "";
    try {
      await useIdentityStore
        .getState()
        .saveGlobal("Draft", "draft@example.test", "v1");
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error);
    }

    expect(errorMessage).toBe("email write failed");
    expect(useIdentityStore.getState().global?.name).toBe("Alice");
    expect(useIdentityStore.getState().fingerprint).toBe("v1");
  } finally {
    restore();
  }
});

function identity(
  name: string,
  email: string,
  fingerprint: string,
): GlobalIdentityResult {
  return { global: { name, email }, source: "global", fingerprint };
}

function resetIdentityStore(result?: GlobalIdentityResult) {
  useIdentityStore.setState({
    global: result?.global ?? null,
    source: result?.source ?? "missing",
    fingerprint: result?.fingerprint ?? "",
    loaded: Boolean(result),
    loading: false,
    loadError: null,
    requestGeneration: 0,
    refreshVersion: 0,
  });
}

function installTestWindow() {
  const dom = new JSDOM("<!doctype html><html><body></body></html>");
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: dom.window,
    writable: true,
  });
  resetIdentityStore();

  return () => {
    clearNativeMocks();
    resetIdentityStore();
    if (previous) Object.defineProperty(globalThis, "window", previous);
    else Reflect.deleteProperty(globalThis, "window");
    dom.window.close();
  };
}

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}
