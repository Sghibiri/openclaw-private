// Run gate: refuse agent runs while the privacy config is unsafe, while a
// service a private run depends on is not up, and when the run's resolved model
// breaks the rules (not attested or local in private mode, outside the EU when
// residency is "eu").
//
// Plugins cannot veto gateway boot, so this is where an unsafe config is
// enforced for agent runs: the gateway starts, every run is refused with a
// pointer to `openclaw privacy status`, and the reason is logged once per change.
import { serviceState, type PackServiceId } from "../../../shared/rules/service-registry.js";
import type { PrivacySettings } from "../../../shared/rules/settings.js";
import {
  defaultLocalBaseUrl,
  isRemoteOllamaModel,
  resolveProviderTrust,
} from "../../../shared/rules/trust.js";
import {
  isLoopbackUrl,
  validatePrivacyConfig,
  type HostConfig,
  type PrivacyConfigIssue,
} from "../../../shared/rules/validate.js";

export type RunGateDecision = { outcome: "block"; reason: string; message: string } | undefined;

export type RunGateContext = {
  agentId?: string;
  /** The run's execution workspace; skills there load too. */
  workspaceDir?: string;
  modelProviderId?: string;
  modelId?: string;
};

const RELAY_SERVICE: Record<string, PackServiceId> = {
  tinfoil: "tinfoil-attested-relay",
  privatemode: "privatemode-attested-relay",
};

function block(reason: string, message: string): RunGateDecision {
  return { outcome: "block", reason, message };
}

function serviceDown(id: PackServiceId): string | undefined {
  const state = serviceState(id);
  return state?.up ? undefined : (state?.error ?? "not started");
}

export function createRunGate(options: {
  settings: PrivacySettings;
  currentConfig: () => HostConfig;
  onIssues?: (issues: PrivacyConfigIssue[]) => void;
}): (event: unknown, ctx: RunGateContext | undefined) => RunGateDecision {
  const { settings } = options;
  const privateMode = settings.mode === "private";
  let lastReported = "";
  return (_event, ctx) => {
    const config = options.currentConfig();
    const issues = validatePrivacyConfig(config, settings);
    if (issues.length > 0) {
      const fingerprint = issues.map((issue) => `${issue.path}:${issue.message}`).join("\n");
      if (fingerprint !== lastReported) {
        lastReported = fingerprint;
        options.onIssues?.(issues);
      }
      return block(
        "privacy-config",
        `This gateway's privacy configuration has ${issues.length} problem${issues.length === 1 ? "" : "s"}, ` +
          "so agent runs are refused until it is fixed. The owner can see them with: openclaw privacy status",
      );
    }
    lastReported = "";

    if (privateMode) {
      const proxyDown = serviceDown("privacy-egress-proxy");
      if (proxyDown) {
        return block(
          "privacy-service",
          `The privacy egress proxy is not running (${proxyDown}), so private runs are refused. Check the gateway log.`,
        );
      }
    }

    const provider = ctx?.modelProviderId?.trim().toLowerCase();
    if (!provider) {
      return privateMode
        ? block("privacy-model", "A private run must name its model provider; refused.")
        : undefined;
    }
    const trust = resolveProviderTrust(provider, settings.providers);
    const relayService = RELAY_SERVICE[provider];
    if (trust.attested && relayService) {
      const relayDown = serviceDown(relayService);
      if (relayDown) {
        return block(
          "privacy-service",
          `The ${provider} attested relay is not running (${relayDown}), so runs on ${provider} are refused. ` +
            "Another program may hold its port; check the gateway log.",
        );
      }
    }
    if (provider === "ollama" && isRemoteOllamaModel(ctx?.modelId)) {
      if (privateMode || settings.residency === "eu") {
        return block(
          "privacy-model",
          `"ollama/${ctx?.modelId}" is an Ollama cloud model that runs on ollama.com, not on this machine.`,
        );
      }
    }
    const baseUrl = config.models?.providers?.[provider]?.baseUrl;
    const local =
      trust.region === "local" && isLoopbackUrl(baseUrl ?? defaultLocalBaseUrl(provider));
    if (privateMode && !trust.attested && !local) {
      return block(
        "privacy-model",
        `A private agent cannot run on "${provider}/${ctx?.modelId ?? "?"}": only attested or local models are allowed here.`,
      );
    }
    if (settings.residency === "eu" && trust.region !== "eu" && !local) {
      return block(
        "privacy-residency",
        `"${provider}" is not an EU provider and this gateway is EU-only.`,
      );
    }
    return undefined;
  };
}
