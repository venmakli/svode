import type {
  SystemCollectionDeveloperDiagnostic,
  SystemCollectionInstance,
} from "./types";
import { readSystemCollectionPresentationRuntime } from "./runtime";

export interface SystemCollectionInstanceValidation {
  diagnostics: readonly SystemCollectionDeveloperDiagnostic[];
  valid: boolean;
}

export interface SystemCollectionInstanceRegistration {
  release(): void;
}

function diagnostic(
  code: SystemCollectionDeveloperDiagnostic["code"],
  message: string,
): SystemCollectionDeveloperDiagnostic {
  return { code, message };
}

function validateInstanceKey(instanceKey: string): void {
  if (instanceKey.length === 0 || instanceKey.trim() !== instanceKey) {
    throw new Error(
      "System Collection instanceKey must be a non-empty, trimmed stable key.",
    );
  }
}

export function validateSystemCollectionInstance(
  instance: SystemCollectionInstance,
): SystemCollectionInstanceValidation {
  const diagnostics: SystemCollectionDeveloperDiagnostic[] = [];

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
      readSystemCollectionPresentationRuntime(presentation).instance;
    if (presentationIds.has(descriptor.id)) {
      diagnostics.push(
        diagnostic(
          "duplicate-presentation-id",
          `System Collection instance "${instance.instanceKey}" declares presentation "${descriptor.id}" more than once.`,
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

export function resolveSystemCollectionPresentationId(
  instance: SystemCollectionInstance,
  savedPresentationId?: string | null,
): string | null {
  const presentationIds = instance.presentations.map(
    (presentation) =>
      readSystemCollectionPresentationRuntime(presentation).instance.descriptor
        .id,
  );

  if (savedPresentationId && presentationIds.includes(savedPresentationId)) {
    return savedPresentationId;
  }
  if (presentationIds.includes(instance.defaultPresentationId)) {
    return instance.defaultPresentationId;
  }
  return presentationIds[0] ?? null;
}

export class SystemCollectionInstanceRegistry {
  readonly #listeners = new Set<() => void>();
  readonly #registrations = new Map<string, Set<symbol>>();

  register(instanceKey: string): SystemCollectionInstanceRegistration {
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
