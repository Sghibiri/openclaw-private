import type { AnyAgentTool } from "openclaw/plugin-sdk/plugin-entry";
import { Type } from "typebox";
// The agent side of take-the-wheel: ask a person to step in. The agent can
// never take or release control itself; it can only raise its hand.
import type { PrivacyAuditEvent } from "../../../shared/audit.js";
import type { ControlRegistry } from "./control.js";

export const REQUEST_HELP_TOOL_NAME = "request_help";

const RequestHelpSchema = Type.Object({
  reason: Type.String({
    description:
      "What you are stuck on and what the person should do (a login page, a captcha, a choice only they can make). No secrets.",
  }),
});

export function createRequestHelpTool(options: {
  agentId: string | undefined;
  controls: ControlRegistry;
  record: (event: PrivacyAuditEvent) => void;
}): AnyAgentTool {
  return {
    label: "Request help",
    name: REQUEST_HELP_TOOL_NAME,
    description:
      "Ask a person to take control of this agent's computer. Use it when you hit a login, a captcha, or a decision " +
      "only the owner can make. You cannot take or hand back control yourself; while the person holds it every " +
      "action except reading is refused. Tell the person in your reply what you need.",
    parameters: RequestHelpSchema,
    execute: async (_toolCallId, args) => {
      const agentId = options.agentId?.trim();
      if (!agentId) {
        return {
          content: [{ type: "text", text: "This tool needs an agent context; none was provided." }],
          details: { ok: false, reason: "no_agent" },
        };
      }
      const reason = (args as { reason?: unknown }).reason;
      const state = options.controls.for(agentId).requestHelp(reason);
      options.record({ kind: "control", agentId, event: "help_requested", by: "agent" });
      return {
        content: [
          {
            type: "text",
            text:
              `Help requested for agent "${agentId}". A person can take control with ` +
              `\`openclaw privacy control take ${agentId}\` and hand it back with \`... release ${agentId}\`. ` +
              "Explain in your reply what you need, then wait; do not retry the blocked action.",
          },
        ],
        details: { ok: true, agentId, requestedAt: state.requestedAt, holder: state.holder },
      };
    },
  };
}
