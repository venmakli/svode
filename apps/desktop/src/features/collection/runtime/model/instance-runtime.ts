import type {
  CollectionDeveloperDiagnostic,
  CollectionInstance,
} from "./types";
import { readCollectionPresentationRuntime } from "./runtime";

export interface CollectionInstanceValidation {
  diagnostics: readonly CollectionDeveloperDiagnostic[];
  valid: boolean;
}

export interface CollectionInstanceRegistration {
  release(): void;
}

function diagnostic(
  code: CollectionDeveloperDiagnostic["code"],
  message: string,
): CollectionDeveloperDiagnostic {
  return { code, message };
}

function validateInstanceKey(instanceKey: string): void {
  if (instanceKey.length === 0 || instanceKey.trim() !== instanceKey) {
    throw new Error(
      "Collection instanceKey must be a non-empty, trimmed stable key.",
    );
  }
}

export function validateCollectionInstance(
  instance: CollectionInstance,
): CollectionInstanceValidation {
  const diagnostics: CollectionDeveloperDiagnostic[] = [];

  try {
    validateInstanceKey(instance.instanceKey);
  } catch (error) {
    diagnostics.push(
      diagnostic(
        "invalid-instance-key",
        error instanceof Error ? error.message : String(error),
      ),
    );
  }

  const presentationIds = new Set<string>();
  for (const presentation of instance.presentations) {
    const { descriptor } =
      readCollectionPresentationRuntime(presentation).instance;
    if (presentationIds.has(descriptor.id)) {
      diagnostics.push(
        diagnostic(
          "duplicate-presentation-id",
          `Collection instance "${instance.instanceKey}" declares presentation "${descriptor.id}" more than once.`,
        ),
      );
    }
    presentationIds.add(descriptor.id);
  }

  if (!presentationIds.has(instance.defaultPresentationId)) {
    diagnostics.push(
      diagnostic(
        "invalid-default-presentation",
        `Default presentation "${instance.defaultPresentationId}" is not available in instance "${instance.instanceKey}".`,
      ),
    );
  }

  return {
    diagnostics,
    valid: diagnostics.length === 0,
  };
}

export function resolveCollectionPresentationId(
  instance: CollectionInstance,
  savedPresentationId?: string | null,
): string | null {
  const presentationIds = instance.presentations.map(
    (presentation) =>
      readCollectionPresentationRuntime(presentation).instance.descriptor.id,
  );

  if (savedPresentationId && presentationIds.includes(savedPresentationId)) {
    return savedPresentationId;
  }
  if (presentationIds.includes(instance.defaultPresentationId)) {
    return instance.defaultPresentationId;
  }
  return presentationIds[0] ?? null;
}

export class CollectionInstanceRegistry {
  readonly #listeners = new Set<() => void>();
  readonly #registrations = new Map<string, Set<symbol>>();

  register(instanceKey: string): CollectionInstanceRegistration {
    validateInstanceKey(instanceKey);
    const registration = Symbol(instanceKey);
    const registrations =
      this.#registrations.get(instanceKey) ?? new Set<symbol>();
    registrations.add(registration);
    this.#registrations.set(instanceKey, registrations);
    this.#notify();
    let released = false;

    return {
      release: () => {
        if (released) {
          return;
        }
        released = true;
        const current = this.#registrations.get(instanceKey);
        current?.delete(registration);
        if (current?.size === 0) {
          this.#registrations.delete(instanceKey);
        }
        this.#notify();
      },
    };
  }

  getCount(instanceKey: string): number {
    return this.#registrations.get(instanceKey)?.size ?? 0;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  #notify(): void {
    for (const listener of this.#listeners) {
      listener();
    }
  }
}
