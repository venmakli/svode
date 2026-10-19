import claudeCode from "@lobehub/icons-static-svg/icons/claudecode-color.svg?url";
import claudeCodeMono from "@lobehub/icons-static-svg/icons/claudecode.svg?url";
import codex from "@lobehub/icons-static-svg/icons/codex-color.svg?url";
import codexMono from "@lobehub/icons-static-svg/icons/codex.svg?url";
import cursor from "@lobehub/icons-static-svg/icons/cursor.svg?url";
import grok from "@lobehub/icons-static-svg/icons/grok.svg?url";
import hermes from "@lobehub/icons-static-svg/icons/hermesagent.svg?url";
import kimi from "@lobehub/icons-static-svg/icons/kimi.svg?url";
import opencode from "@lobehub/icons-static-svg/icons/opencode.svg?url";
import pi from "@lobehub/icons-static-svg/icons/pi.svg?url";
import qwen from "@lobehub/icons-static-svg/icons/qwen-color.svg?url";
import qwenMono from "@lobehub/icons-static-svg/icons/qwen.svg?url";

/**
 * A brand icon from lobe-icons (MIT): a colored one is shown as is, a
 * monochrome one takes the current text color. `mono` is the monochrome
 * variant every agent has, for a muted icon.
 */
export interface AgentIconAsset {
  src: string;
  colored: boolean;
  mono: string;
}

export const AGENT_ICONS: Readonly<Record<string, AgentIconAsset>> = {
  codex: { src: codex, colored: true, mono: codexMono },
  "claude-code": { src: claudeCode, colored: true, mono: claudeCodeMono },
  cursor: { src: cursor, colored: false, mono: cursor },
  opencode: { src: opencode, colored: false, mono: opencode },
  hermes: { src: hermes, colored: false, mono: hermes },
  pi: { src: pi, colored: false, mono: pi },
  "qwen-code": { src: qwen, colored: true, mono: qwenMono },
  "kimi-code": { src: kimi, colored: false, mono: kimi },
  "grok-build": { src: grok, colored: false, mono: grok },
};
