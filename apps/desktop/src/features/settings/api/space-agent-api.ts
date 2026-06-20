import {
  listAgentModels as listPlatformAgentModels,
  readAgentsMd as readPlatformAgentsMd,
  setupCliSymlinks as setupPlatformCliSymlinks,
  teardownCliSymlinks as teardownPlatformCliSymlinks,
} from "@/platform/agent/agent-api";

import type { ModelOption } from "@/features/chat";

export interface SetupCliSymlinksInput extends Record<string, unknown> {
  spacePath: string;
  cliName: string;
  projectPath?: string | null;
}

export function listAgentModels(spacePath: string): Promise<ModelOption[]> {
  return listPlatformAgentModels(spacePath);
}

export function readAgentsMd(spacePath: string): Promise<string | null> {
  return readPlatformAgentsMd(spacePath);
}

export function setupCliSymlinks(
  input: SetupCliSymlinksInput,
): Promise<string[]> {
  return setupPlatformCliSymlinks(input);
}

export function teardownCliSymlinks(
  input: SetupCliSymlinksInput,
): Promise<void> {
  return teardownPlatformCliSymlinks(input);
}
