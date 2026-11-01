import * as m from "@/paraglide/messages.js";

import type { RoutineLaunchRefusal } from "../model/types";

/** Why a launch was refused, with the setting and value when the reason is in them. */
export function routineLaunchRefusalText(
  refusal: RoutineLaunchRefusal,
  agentLabel: (agent: string) => string,
): string {
  const agent = refusal.agent ? agentLabel(refusal.agent) : "";
  const value = { setting: refusal.setting ?? "", value: refusal.value ?? "" };
  let reason: string;
  switch (refusal.reason) {
    case "default_agent_not_set":
      reason = m.routines_refusal_default_agent_not_set();
      break;
    case "unknown_agent":
      reason = m.routines_refusal_unknown_agent({ agent });
      break;
    case "mode_unavailable":
      reason = m.routines_refusal_mode_unavailable();
      break;
    case "agent_not_ready":
      reason = m.routines_refusal_agent_not_ready({ agent });
      break;
    case "connection_failed":
      reason = m.routines_refusal_connection_failed({ agent });
      break;
    case "setting_not_declared":
      reason = m.routines_refusal_setting_not_declared({ agent, ...value });
      break;
    case "setting_is_mode":
      reason = m.routines_refusal_setting_is_mode({ agent, ...value });
      break;
    case "setting_refused":
      reason = m.routines_refusal_setting_refused({ agent, ...value });
      break;
  }
  return m.routines_refusal_line({ reason });
}
