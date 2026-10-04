import {
  ErrorCodes,
  errorShape,
  type GatewayRequestHandlerOptions,
} from "openclaw/plugin-sdk/gateway-runtime";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
// Gateway methods for the human side of take-the-wheel.
//
// The agent can only ask for help (request_help tool); a person takes or
// releases control through these methods, from the CLI or any operator client.
// While a person holds control the action gateway refuses every non-read
// action for that agent. Each transition is an audit row.
import type { PrivacyAuditEvent } from "../../../shared/audit.js";
import type { ControlRegistry, ControlState } from "./control.js";

type Request = Pick<GatewayRequestHandlerOptions, "respond"> & { params?: unknown };

export const CONTROL_METHODS = {
  list: "privacy.control.list",
  take: "privacy.control.take",
  release: "privacy.control.release",
} as const;

export type ControlMethodDeps = {
  controls: ControlRegistry;
  record: (event: PrivacyAuditEvent) => void;
};

const AGENT_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

function readAgentId(params: unknown): string | null {
  const agentId = (params as { agentId?: unknown } | undefined)?.agentId;
  return typeof agentId === "string" && AGENT_ID_RE.test(agentId.trim()) ? agentId.trim() : null;
}

function invalid(respond: Request["respond"], message: string): void {
  respond(false, { error: message }, errorShape(ErrorCodes.INVALID_REQUEST, message));
}

export type ControlView = { agentId: string; state: ControlState };

export function listControls(deps: ControlMethodDeps, { respond }: Request): void {
  const controls: ControlView[] = deps.controls
    .list()
    .toSorted((a, b) => a.agentId.localeCompare(b.agentId));
  respond(true, { controls });
}

export function takeControl(deps: ControlMethodDeps, { params, respond }: Request): void {
  const agentId = readAgentId(params);
  if (!agentId) {
    invalid(respond, `${CONTROL_METHODS.take} requires agentId (letters, digits, _ or -).`);
    return;
  }
  const control = deps.controls.for(agentId);
  const before = control.get();
  const state = control.take();
  if (before.holder !== "human") {
    deps.record({ kind: "control", agentId, event: "taken", by: "operator" });
  }
  respond(true, { agentId, state, changed: before.holder !== "human" } satisfies ControlView & {
    changed: boolean;
  });
}

export function releaseControl(deps: ControlMethodDeps, { params, respond }: Request): void {
  const agentId = readAgentId(params);
  if (!agentId) {
    invalid(respond, `${CONTROL_METHODS.release} requires agentId (letters, digits, _ or -).`);
    return;
  }
  const control = deps.controls.for(agentId);
  const before = control.get();
  const state = control.release();
  if (before.holder === "human") {
    deps.record({ kind: "control", agentId, event: "released", by: "operator" });
  }
  respond(true, { agentId, state, changed: before.holder === "human" } satisfies ControlView & {
    changed: boolean;
  });
}

export function registerControlGatewayMethods(
  api: OpenClawPluginApi,
  deps: ControlMethodDeps,
): void {
  api.registerGatewayMethod(CONTROL_METHODS.list, (request) => listControls(deps, request), {
    scope: "operator.read",
  });
  api.registerGatewayMethod(CONTROL_METHODS.take, (request) => takeControl(deps, request), {
    scope: "operator.admin",
  });
  api.registerGatewayMethod(CONTROL_METHODS.release, (request) => releaseControl(deps, request), {
    scope: "operator.admin",
  });
}
