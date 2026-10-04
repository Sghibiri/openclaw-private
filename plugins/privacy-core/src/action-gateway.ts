// Decide, record, then act.
//
// Ported in spirit from OpenBot's computer gateway (`govern()` in
// server/src/computer/gateway.ts; Portions Copyright (c) 2026 CopilotKit, MIT
// License), re-targeted to OpenClaw's before_tool_call trusted policy chain.
// The audit row is written before the tool runs, not after it succeeds, so a
// trail that only contains successes cannot exist. No code path acts without
// the record existing first.
import type { PluginTrustedToolPolicyRegistration } from "openclaw/plugin-sdk/plugin-entry";
import type { PrivacyAuditEvent } from "../../../shared/audit.js";

type PluginHookBeforeToolCallEvent = Parameters<PluginTrustedToolPolicyRegistration["evaluate"]>[0];
type PluginHookToolContext = Parameters<PluginTrustedToolPolicyRegistration["evaluate"]>[1];
import { HUMAN_HAS_CONTROL, type ControlRegistry } from "./control.js";
import { resolveIntentSubject } from "./intent.js";
import {
  evaluateActionPolicy,
  type ActionPolicy,
  type PolicyContext,
  type PolicyDecision,
  type PolicyExpressionProblem,
} from "./policy.js";

export class ActionRefusedError extends Error {
  constructor(
    message: string,
    readonly rule: string | null,
  ) {
    super(message);
    this.name = "ActionRefusedError";
  }
}

/** Tools the gateway governs; MCP tools (`mcp__<server>__<tool>`) are governed too. */
export const GOVERNED_TOOLS = new Set([
  "browser",
  "exec",
  "process",
  "gateway_exec",
  "gateway_process",
  "write",
  "edit",
  "apply_patch",
  "read",
  "ls",
]);

export function isGovernedTool(toolName: string): boolean {
  return GOVERNED_TOOLS.has(toolName) || toolName.startsWith("mcp__");
}

export type ActionGatewayOptions = {
  resolvePolicy: () => ActionPolicy;
  /** A message means "refuse every tool call" (privacy config unsafe). */
  refuseAll?: () => string | undefined;
  controls: ControlRegistry;
  record: (event: PrivacyAuditEvent) => void;
  /** Session-scoped approval facts, e.g. an operator's earlier allow-always. */
  resolveApprovalGranted?: (
    event: PluginHookBeforeToolCallEvent,
    ctx: PluginHookToolContext,
  ) => boolean;
  onExpressionProblem?: (problem: PolicyExpressionProblem) => void;
};

export function buildPolicyContext(params: {
  event: PluginHookBeforeToolCallEvent;
  ctx: PluginHookToolContext;
  approvalGranted: boolean;
}): PolicyContext {
  const { event, ctx } = params;
  const subject = resolveIntentSubject(event.toolName, event.params, event.derivedPaths);
  return {
    tool: { name: event.toolName },
    agent: { id: ctx.agentId ?? "" },
    page: subject.page,
    element: subject.element,
    key: subject.key,
    intent: subject.intent,
    file: subject.file,
    command: subject.command,
    mcp: subject.mcp,
    approval: { granted: params.approvalGranted },
    initiator: { kind: ctx.channelId ? "person" : "deployment", id: "" },
  };
}

export function decisionAuditEvent(params: {
  context: PolicyContext;
  decision: PolicyDecision;
  outcome: "allowed" | "refused" | "approval_required" | "human_has_control";
}): PrivacyAuditEvent {
  const { context, decision } = params;
  return {
    kind: "action",
    tool: context.tool.name,
    intent: context.intent,
    agentId: context.agent.id,
    host: context.page.host,
    // The command text is recorded; typed text, file contents and results never are.
    ...(context.command ? { command: context.command } : {}),
    ...(context.file.path ? { file: context.file.path } : {}),
    ...(context.mcp.server ? { mcpServer: context.mcp.server, mcpTool: context.mcp.tool } : {}),
    outcome: params.outcome,
    rule: decision.matched,
    source: decision.source,
    mode: decision.mode,
  };
}

export function createActionGatewayPolicy(
  options: ActionGatewayOptions,
): PluginTrustedToolPolicyRegistration {
  return {
    id: "privacy-action-gateway",
    description:
      "Evaluates the CEL action policy, records the decision, then allows, refuses or asks for approval.",
    // No matcher: the host matcher takes exact names only, and MCP tool names are dynamic.
    evaluate(event, ctx) {
      // Tool policies are delivered without conversation access, so this holds
      // even when the run gate is not: no tool runs while the config is unsafe.
      const unsafe = options.refuseAll?.();
      if (unsafe) {
        return { block: true, blockReason: `Refused: ${unsafe}.` };
      }
      if (!isGovernedTool(event.toolName)) {
        return undefined;
      }
      const agentId = ctx.agentId ?? "";
      const approvalGranted = options.resolveApprovalGranted?.(event, ctx) ?? false;
      const context = buildPolicyContext({ event, ctx, approvalGranted });
      const decision = evaluateActionPolicy(options.resolvePolicy(), context, {
        onExpressionProblem: options.onExpressionProblem,
      });

      // While a person drives, the agent is refused, never queued.
      if (agentId && options.controls.for(agentId).humanMayDrive() && context.intent !== "read") {
        options.record(decisionAuditEvent({ context, decision, outcome: "human_has_control" }));
        return { block: true, blockReason: HUMAN_HAS_CONTROL };
      }

      if (!decision.forward && !decision.needsApproval) {
        options.record(decisionAuditEvent({ context, decision, outcome: "refused" }));
        return { block: true, blockReason: decision.reason };
      }
      if (decision.needsApproval && decision.mode === "enforce") {
        options.record(decisionAuditEvent({ context, decision, outcome: "approval_required" }));
        return {
          requireApproval: {
            title: `Approve ${context.intent || event.toolName} by ${agentId || "agent"}`,
            description: decision.reason,
            severity: "warning",
          },
        };
      }
      options.record(decisionAuditEvent({ context, decision, outcome: "allowed" }));
      return undefined;
    },
  };
}
