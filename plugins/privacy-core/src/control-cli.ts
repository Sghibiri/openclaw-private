// `openclaw privacy control list|take|release`: the person's side of
// take-the-wheel, over the Gateway so the change lands in the running process.
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import {
  addGatewayClientOptions,
  callGatewayFromCli,
  type GatewayRpcOpts,
} from "openclaw/plugin-sdk/gateway-runtime";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { CONTROL_METHODS, type ControlView } from "./control-methods.js";

type CliProgram = Parameters<Parameters<OpenClawPluginApi["registerCli"]>[0]>[0]["program"];
type PrivacyCommand = ReturnType<CliProgram["command"]>;

type ControlOptions = GatewayRpcOpts & { json?: boolean; reason?: string };

export type ControlGatewayCaller = (
  method: string,
  options: GatewayRpcOpts,
  params?: unknown,
) => Promise<unknown>;

const defaultCaller: ControlGatewayCaller = async (method, options, params) =>
  await callGatewayFromCli(method, options, params, {
    mode: "cli",
    scopes: ["operator.admin", "operator.write", "operator.read"],
  });

export function formatControlView(view: ControlView): string {
  const { agentId, state } = view;
  const parts = [
    `${agentId}: ${state.holder === "human" ? "a person has control" : "agent has control"} since ${state.since}`,
  ];
  if (state.requested) {
    parts.push(
      `help requested${state.requestedAt ? ` at ${state.requestedAt}` : ""}${state.reason ? `: ${state.reason}` : ""}`,
    );
  }
  if (state.secretWanted) {
    parts.push(`waiting for a value: ${state.secretWanted}`);
  }
  return parts.join("; ");
}

function readControls(result: unknown): ControlView[] {
  const controls = (result as { controls?: unknown } | undefined)?.controls;
  return Array.isArray(controls) ? (controls as ControlView[]) : [];
}

function writeResult(result: unknown, options: { json?: boolean }, text: () => string): void {
  process.stdout.write(options.json ? `${JSON.stringify(result, null, 2)}\n` : `${text()}\n`);
}

export function registerPrivacyControlCli(
  privacy: PrivacyCommand,
  call: ControlGatewayCaller = defaultCaller,
): void {
  const control = privacy
    .command("control")
    .description("Take or hand back control of an agent's computer (take-the-wheel)");

  addGatewayClientOptions(
    control
      .command("list")
      .description("Show which agents a person controls and which asked for help")
      .option("--json", "Print JSON"),
  ).action(async (options: ControlOptions) => {
    const result = await call(CONTROL_METHODS.list, options);
    writeResult(result, options, () => {
      const views = readControls(result);
      return views.length === 0
        ? "No agent has asked for help or been taken over since the Gateway started."
        : views.map(formatControlView).join("\n");
    });
  });

  addGatewayClientOptions(
    control
      .command("take <agentId>")
      .description("Take control: the agent's non-read actions are refused until you release it")
      .option("--json", "Print JSON"),
  ).action(async (agentId: string, options: ControlOptions) => {
    const result = await call(CONTROL_METHODS.take, options, { agentId });
    writeResult(result, options, () => {
      const view = result as ControlView & { changed?: boolean };
      return `${view.changed ? "You now have control of" : "You already had control of"} "${view.agentId}". Release it with: openclaw privacy control release ${view.agentId}`;
    });
  });

  addGatewayClientOptions(
    control
      .command("release <agentId>")
      .description("Hand control back to the agent")
      .option("--json", "Print JSON"),
  ).action(async (agentId: string, options: ControlOptions) => {
    const result = await call(CONTROL_METHODS.release, options, { agentId });
    writeResult(result, options, () => {
      const view = result as ControlView & { changed?: boolean };
      return view.changed
        ? `Control of "${view.agentId}" handed back to the agent.`
        : `The agent already had control of "${view.agentId}".`;
    });
  });
}

export function describeControlError(error: unknown): string {
  return `privacy control: ${formatErrorMessage(error)}`;
}
