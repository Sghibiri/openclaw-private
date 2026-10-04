// Privacy Core: the governance half of OpenClaw Private, as a plugin on stock OpenClaw.
//
// - Run gate: refuses agent runs while the privacy config is unsafe, and any
//   private run on a model that is not attested or local.
// - Egress proxy (private mode): `proxy.proxyUrl` points here, so every
//   outbound connection of the gateway goes through an allowlist.
// - Action gateway: CEL policy, decide-record-act, take-the-wheel.
// - The door: `ask_private_agent` on the main gateway, the reply filter on the private one.
// - Skill approval: runs are refused while a skill folder the gateway loads has a
//   fingerprint the owner has not approved (always on in private mode).
// - `openclaw privacy status | control | memory | skills`.
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { recordPrivacyAuditEvent, type PrivacyAuditEvent } from "../../shared/audit.js";
import { privacyConfigRefusal } from "../../shared/rules/guard.js";
import { resolvePrivacySettings } from "../../shared/rules/settings.js";
import { authoredConfig } from "../../shared/rules/source-config.js";
import {
  formatPrivacyConfigIssues,
  resolveEgressAllowlist,
  validatePrivacyConfig,
  type HostConfig,
} from "../../shared/rules/validate.js";
import { createActionGatewayPolicy } from "./src/action-gateway.js";
import { createAskPrivateAgentTool, type DoorPeer } from "./src/ask-private-agent-tool.js";
import { registerControlGatewayMethods } from "./src/control-methods.js";
import { createControlRegistry } from "./src/control.js";
import { createDoorReplyHook } from "./src/door-hook.js";
import { createEgressProxy, type EgressProxy } from "./src/egress-proxy.js";
import { resolveActionPolicy } from "./src/policy.js";
import { createRequestHelpTool, REQUEST_HELP_TOOL_NAME } from "./src/request-help-tool.js";
import { createRunGate } from "./src/run-gate.js";
import { createSkillApprovalCheck } from "./src/skill-gate.js";

function readDoorPeers(config: { channels?: unknown }): DoorPeer[] {
  const a2a = (config.channels as { a2a?: { peers?: Record<string, unknown> } } | undefined)?.a2a;
  const peers: DoorPeer[] = [];
  for (const [name, raw] of Object.entries(a2a?.peers ?? {})) {
    const peer = raw as { url?: unknown; outboundToken?: unknown } | undefined;
    if (typeof peer?.url !== "string" || !peer.url.trim()) {
      continue;
    }
    peers.push({
      name,
      url: peer.url.trim(),
      ...(typeof peer.outboundToken === "string" && peer.outboundToken
        ? { outboundToken: peer.outboundToken }
        : {}),
    });
  }
  return peers;
}

export const privacyControls = createControlRegistry();

export default definePluginEntry({
  id: "privacy-core",
  name: "Privacy Core",
  description: "Run gate, egress allowlist, CEL action policy, the door, and take-the-wheel",
  register(api) {
    const settings = resolvePrivacySettings(api.pluginConfig);
    const privateMode = settings.mode === "private";
    const record = (event: PrivacyAuditEvent) => void recordPrivacyAuditEvent(event);
    const currentConfig = (): HostConfig => authoredConfig(api.config);

    const skillApproval = settings.skills.approval === "required";
    // The run gate is only needed when a privacy posture is requested.
    if (privateMode || settings.residency === "eu" || skillApproval) {
      const runGate = createRunGate({
        settings,
        currentConfig,
        onIssues: (issues) =>
          api.logger.error(
            `privacy config is unsafe; agent runs are refused until fixed:\n${formatPrivacyConfigIssues(issues)}`,
          ),
      });
      const skillCheck = createSkillApprovalCheck({
        currentConfig,
        record,
        log: (message) => api.logger.warn(`skill not approved: ${message}`),
      });
      api.on("before_agent_run", async (event, ctx) => {
        const decision = runGate(event, ctx);
        if (decision || !skillApproval) {
          return decision;
        }
        return await skillCheck(ctx);
      });
      api.on("gateway_start", () => {
        const config = currentConfig();
        const issues = validatePrivacyConfig(config, settings);
        record({
          kind: "validation",
          ok: issues.length === 0,
          issues: issues.length,
          mode: settings.mode,
          residency: settings.residency,
          ...(privateMode ? { egressAllow: resolveEgressAllowlist(config, settings) } : {}),
        });
        if (issues.length > 0) {
          api.logger.error(
            `privacy config is unsafe; agent runs are refused until fixed (see openclaw privacy status):\n${formatPrivacyConfigIssues(issues)}`,
          );
        }
      });
    }

    if (skillApproval) {
      // OpenClaw reports skills it creates or changes (Workshop, installs, uploads);
      // say right away that they wait for the owner's approval.
      api.on("skill_changed", (event) => {
        const name = event.after?.name ?? event.before?.name;
        if (!name) {
          return;
        }
        record({ kind: "skill", action: "changed", name, source: event.source });
        if (event.action !== "removed") {
          api.logger.warn(
            `skill "${name}" was ${event.action} (${event.source}); agent runs are refused until the owner runs: openclaw privacy skills approve ${name}`,
          );
        }
      });
    }

    if (privateMode) {
      // Every outbound connection of this gateway goes through this proxy.
      let proxy: EgressProxy | undefined;
      api.registerService({
        id: "privacy-egress-proxy",
        start: async () => {
          proxy = createEgressProxy({
            port: settings.egress.proxyPort,
            allow: () => resolveEgressAllowlist(currentConfig(), settings),
            guard: () => privacyConfigRefusal(currentConfig()),
            onRefused: (host, reason) => {
              record({ kind: "egress_blocked", host, source: `proxy:${reason}` });
              api.logger.warn(`privacy egress refused (${reason}): ${host}`);
            },
          });
          api.logger.info(`privacy egress proxy listening at ${await proxy.start()}`);
        },
        stop: async () => {
          await proxy?.stop();
          proxy = undefined;
        },
      });
      // The private side of the door: filter and record every A2A reply.
      api.on(
        "reply_payload_sending",
        createDoorReplyHook({
          mode: settings.boundary.mode,
          maxChars: settings.boundary.maxChars,
          record,
        }),
      );
    } else {
      // The main side of the door: one tool that asks a private peer and gets text back.
      const peers = readDoorPeers(api.config);
      if (peers.length > 0) {
        api.registerTool(createAskPrivateAgentTool({ peers }));
      }
    }

    api.registerCli(
      async ({ program }) => {
        const { registerPrivacyCli } = await import("./src/status-cli.js");
        registerPrivacyCli(program, api);
      },
      {
        descriptors: [
          {
            name: "privacy",
            description: "Privacy posture, take-the-wheel, and agent memory",
            hasSubcommands: true,
          },
        ],
      },
    );

    // Take-the-wheel: the agent raises its hand; a person takes or releases
    // control over the Gateway. While a person holds it, the action gateway
    // below refuses every non-read action for that agent.
    api.registerTool(
      (ctx) => createRequestHelpTool({ agentId: ctx.agentId, controls: privacyControls, record }),
      { name: REQUEST_HELP_TOOL_NAME },
    );
    registerControlGatewayMethods(api, { controls: privacyControls, record });
    const policy = resolveActionPolicy({ privateMode, configured: settings.policy });
    api.registerTrustedToolPolicy(
      createActionGatewayPolicy({
        resolvePolicy: () => policy,
        refuseAll: () => privacyConfigRefusal(currentConfig()),
        controls: privacyControls,
        record,
        onExpressionProblem: (problem) =>
          api.logger.error(
            `privacy policy expression problem: ${problem.expression}: ${problem.error} (treated as ${problem.treatedAs})`,
          ),
      }),
    );
  },
});
