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
  readonly #registrations = new Map<string, symbol>();

  register(instanceKey: string): SystemCollectionInstanceRegistration {
    validateInstanceKey(instanceKey);
    if (this.#registrations.has(instanceKey)) {
      throw new Error(
        `System Collection instanceKey "${instanceKey}" is already mounted.`,
      );
    }

    const registration = Symbol(instanceKey);
    this.#registrations.set(instanceKey, registration);
    let released = false;

    return {
      release: () => {
        if (released) {
          return;
        }
        released = true;
        if (this.#registrations.get(instanceKey) === registration) {
          this.#registrations.delete(instanceKey);
        }
      },
    };
  }
}
