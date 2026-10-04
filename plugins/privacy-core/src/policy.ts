// CEL action policy: whether an agent may take one particular action.
//
// Ported from OpenBot (https://github.com/CopilotKit/OpenBot,
// server/src/computer/policy.ts). Portions Copyright (c) 2026 CopilotKit,
// MIT License. Kept from it: CEL expressions, `dry-run` vs `enforce`,
// default-deny, deny-before-allow, and fail-closed evaluation of broken rules.
// Added here: an `approve` list. An expression in it that is true (and not
// denied) means the action needs an operator's approval before it runs.
import { evaluate } from "cel-js";

export type PolicyMode = "dry-run" | "enforce";

export type ActionPolicy = {
  /** `enforce` blocks. `dry-run` decides and records, and lets everything through. */
  mode: PolicyMode;
  /** Evaluated first. Any expression true means refused, whatever `allow` says. */
  deny: string[];
  /** Evaluated second. Any expression true means the action waits for an operator's approval. */
  approve: string[];
  /** Any expression true means permitted. Empty means nothing is permitted. */
  allow: string[];
};

export type PolicyIntent =
  | "activate"
  | "type"
  | "navigate"
  | "read"
  | "read_file"
  | "write_file"
  | "list_files"
  | "read_tool"
  | "write_tool"
  | "run_command";

/**
 * The attributes a rule can be written against.
 *
 * Every field is always bound, neutral-empty when it does not apply, because
 * cel-js throws on an unbound identifier and a thrown deny rule counts as a
 * match. A rule naming `command` must not refuse every browser click.
 */
export type PolicyContext = {
  tool: { name: string };
  agent: { id: string };
  page: { url: string; host: string };
  element: { ref: string; role: string; name: string; type: string };
  key: string;
  intent: PolicyIntent | "";
  file: { path: string; name: string; extension: string };
  command: string;
  mcp: { server: string; tool: string; effect: "read" | "write" | "" };
  approval: { granted: boolean };
  initiator: { kind: string; id: string };
};

export type PolicyDecision = {
  allowed: boolean;
  /** True when the action must wait for an operator's approval before it runs. */
  needsApproval: boolean;
  mode: PolicyMode;
  /** Which expression decided it, so the audit row can say why. */
  matched: string | null;
  source: "deny" | "approve" | "allow" | "default";
  /** True when the action should actually be carried out (dry-run forwards refusals). */
  forward: boolean;
  reason: string;
};

/**
 * String helpers registered as CEL globals. cel-js 0.8.2 has no string
 * methods, so `contains` and `matches` are provided here, case-insensitive.
 */
const POLICY_FUNCTIONS: Record<string, CallableFunction> = {
  contains: (haystack: unknown, needle: unknown) =>
    String(haystack).toLowerCase().includes(String(needle).toLowerCase()),
  matches: (value: unknown, pattern: unknown) => {
    try {
      return new RegExp(String(pattern), "i").test(String(value));
    } catch {
      // A broken regex is a broken rule; throwing keeps a deny fail-closed.
      throw new Error(`not a valid pattern: ${String(pattern)}`);
    }
  },
};

export type PolicyExpressionProblem = {
  expression: string;
  error: string;
  treatedAs: boolean;
};

/**
 * Evaluate one expression. Never throws. `onError` is what a broken rule
 * means: a broken allow must not permit, a broken deny must keep denying. A
 * non-boolean result ("Submit order" is valid CEL) is a broken rule too.
 */
function matchesExpression(
  expression: string,
  context: PolicyContext,
  onError: boolean,
  report: (problem: PolicyExpressionProblem) => void,
): boolean {
  try {
    const result = evaluate(
      expression,
      context as unknown as Record<string, unknown>,
      POLICY_FUNCTIONS,
    );
    if (typeof result === "boolean") {
      return result;
    }
    report({
      expression,
      error: `expected a true or false answer, got ${result === null ? "null" : typeof result}`,
      treatedAs: onError,
    });
    return onError;
  } catch (error) {
    report({ expression, error: String(error), treatedAs: onError });
    return onError;
  }
}

/** An absent policy denies: silence is "nothing", not "anything". */
export function evaluateActionPolicy(
  policy: ActionPolicy | null | undefined,
  context: PolicyContext,
  options: { onExpressionProblem?: (problem: PolicyExpressionProblem) => void } = {},
): PolicyDecision {
  const report = options.onExpressionProblem ?? (() => {});
  const mode: PolicyMode = policy?.mode ?? "enforce";
  const deny = policy?.deny ?? [];
  const approve = policy?.approve ?? [];
  const allow = policy?.allow ?? [];

  for (const expression of deny) {
    if (matchesExpression(expression, context, true, report)) {
      return {
        allowed: false,
        needsApproval: false,
        mode,
        matched: expression,
        source: "deny",
        forward: mode === "dry-run",
        reason: describeRefusal(context, expression),
      };
    }
  }
  for (const expression of approve) {
    // A broken approve rule asks for approval rather than waving the action through.
    if (!context.approval.granted && matchesExpression(expression, context, true, report)) {
      return {
        allowed: false,
        needsApproval: true,
        mode,
        matched: expression,
        source: "approve",
        forward: mode === "dry-run",
        reason: describeApprovalNeed(context, expression),
      };
    }
  }
  for (const expression of allow) {
    if (matchesExpression(expression, context, false, report)) {
      return {
        allowed: true,
        needsApproval: false,
        mode,
        matched: expression,
        source: "allow",
        forward: true,
        reason: "Permitted by policy.",
      };
    }
  }
  return {
    allowed: false,
    needsApproval: false,
    mode,
    matched: null,
    source: "default",
    forward: mode === "dry-run",
    reason:
      "No rule in this gateway's policy permits that action, so it was refused. " +
      "An operator can add one under privacy.policy.allow.",
  };
}

function describeSubject(context: PolicyContext): string {
  if (context.command) {
    return `the command \`${context.command}\``;
  }
  if (context.mcp.server || context.mcp.tool) {
    return `${context.mcp.tool} on ${context.mcp.server}`;
  }
  if (context.file.path) {
    return `the file ${context.file.path}`;
  }
  const what = context.element.name
    ? `"${context.element.name}"`
    : `a ${context.intent || context.tool.name} action`;
  return context.page.host ? `${what} on ${context.page.host}` : what;
}

function describeRefusal(context: PolicyContext, expression: string): string {
  return `This gateway's policy does not allow that: ${describeSubject(context)} is blocked by the rule \`${expression}\`.`;
}

function describeApprovalNeed(context: PolicyContext, expression: string): string {
  return `${describeSubject(context)} needs an operator's approval (rule \`${expression}\`).`;
}

/** Private gateways: every write-shaped action waits for an operator; reads are free. */
export const PRIVATE_DEFAULT_ACTION_POLICY: ActionPolicy = {
  mode: "enforce",
  deny: [],
  approve: [
    'intent == "activate" || intent == "type" || intent == "navigate" || intent == "write_file" || intent == "run_command" || intent == "write_tool"',
  ],
  allow: ["true"],
};

/** Standard gateways: OpenBot's shipped default, permissive but recorded. */
export const STANDARD_DEFAULT_ACTION_POLICY: ActionPolicy = {
  mode: "enforce",
  deny: [],
  approve: [],
  allow: ["true"],
};

export function resolveActionPolicy(params: {
  privateMode: boolean;
  configured?: Partial<ActionPolicy> | null;
}): ActionPolicy {
  const base = params.privateMode ? PRIVATE_DEFAULT_ACTION_POLICY : STANDARD_DEFAULT_ACTION_POLICY;
  const configured = params.configured;
  if (!configured) {
    return base;
  }
  return {
    mode: configured.mode ?? base.mode,
    deny: configured.deny ?? base.deny,
    approve: configured.approve ?? base.approve,
    allow: configured.allow ?? base.allow,
  };
}
