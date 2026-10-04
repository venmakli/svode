import claudeCode from "@lobehub/icons-static-svg/icons/claudecode-color.svg?url";
import codex from "@lobehub/icons-static-svg/icons/codex-color.svg?url";
import cursor from "@lobehub/icons-static-svg/icons/cursor.svg?url";
import grok from "@lobehub/icons-static-svg/icons/grok.svg?url";
import hermes from "@lobehub/icons-static-svg/icons/hermesagent.svg?url";
import kimi from "@lobehub/icons-static-svg/icons/kimi-color.svg?url";
import opencode from "@lobehub/icons-static-svg/icons/opencode.svg?url";
import pi from "@lobehub/icons-static-svg/icons/pi.svg?url";
import qwen from "@lobehub/icons-static-svg/icons/qwen-color.svg?url";

/**
 * A brand icon from lobe-icons (MIT): a colored one is shown as is, a
 * monochrome one takes the current text color.
 */
export interface AgentIconAsset {
  src: string;
  colored: boolean;
}

export const AGENT_ICONS: Readonly<Record<string, AgentIconAsset>> = {
  codex: { src: codex, colored: true },
  "claude-code": { src: claudeCode, colored: true },
  cursor: { src: cursor, colored: false },
  opencode: { src: opencode, colored: false },
  hermes: { src: hermes, colored: false },
  pi: { src: pi, colored: false },
  "qwen-code": { src: qwen, colored: true },
  "kimi-code": { src: kimi, colored: true },
  "grok-build": { src: grok, colored: false },
};
