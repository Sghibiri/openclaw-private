// Provider trust table: which model providers this pack treats as private.
//
// Attested providers are served by this pack's own plugins, through a loopback
// relay that verifies the enclave before sending. A provider is only trusted
// when its plugin is the one serving it and its base URL is that relay.
import type { PrivacySettings, ProviderRegion } from "./settings.js";

export type ProviderTrust = {
  attested: boolean;
  region: ProviderRegion;
  /** Plugin that must serve the provider. */
  pluginId?: string;
  /** Hosts the provider's attested client reaches; added to the egress allowlist. */
  egressHosts?: readonly string[];
  /** Default loopback port of the provider plugin's attested relay. */
  relayPort?: number;
  source: "pack" | "operator" | "default";
};

const PACK_TRUST: Record<string, Omit<ProviderTrust, "source">> = {
  tinfoil: {
    attested: true,
    region: "us",
    pluginId: "tinfoil",
    egressHosts: ["atc.tinfoil.sh", "*.tinfoil.sh"],
    relayPort: 19931,
  },
  privatemode: {
    attested: true,
    region: "eu",
    pluginId: "privatemode",
    egressHosts: ["api.privatemode.ai", "cdn.confidential.cloud"],
    relayPort: 19932,
  },
  ollama: { attested: false, region: "local", pluginId: "ollama" },
};

/** Default private model when a private gateway needs one: Tinfoil, or Privatemode for `eu`. */
export function privateDefaultModelRef(residency: PrivacySettings["residency"]): string {
  return residency === "eu" ? "privatemode/gpt-oss-120b" : "tinfoil/gpt-oss-120b";
}

/**
 * Trust facts for a provider: the pack table wins; `providers.<id>.region` may
 * declare only a region for providers the pack does not know; anything else
 * fails closed as unattested and US-hosted.
 */
export function resolveProviderTrust(
  providerId: string,
  operatorRegions: PrivacySettings["providers"] = {},
): ProviderTrust {
  const id = providerId.trim().toLowerCase();
  const pack = PACK_TRUST[id];
  if (pack) {
    return { ...pack, source: "pack" };
  }
  const operator = operatorRegions[id];
  return operator
    ? { attested: false, region: operator.region, source: "operator" }
    : { attested: false, region: "us", source: "default" };
}

export function isPackTrustedProvider(providerId: string): boolean {
  return Object.hasOwn(PACK_TRUST, providerId.trim().toLowerCase());
}

/** Loopback base URL of an attested provider's relay, honoring the plugin's `relay.port`. */
export function expectedRelayBaseUrl(
  trust: ProviderTrust,
  plugins: { entries?: Record<string, { config?: unknown } | undefined> } | undefined,
): string | undefined {
  if (!trust.attested || !trust.pluginId || trust.relayPort === undefined) {
    return undefined;
  }
  const configured = (
    plugins?.entries?.[trust.pluginId]?.config as { relay?: { port?: unknown } } | undefined
  )?.relay?.port;
  const port = typeof configured === "number" ? configured : trust.relayPort;
  return `http://127.0.0.1:${port}/v1`;
}

/** Ollama models that run on ollama.com through a signed-in local daemon, not on this machine. */
export function isRemoteOllamaModel(modelId: string | undefined): boolean {
  return Boolean(modelId && /(?:^|[:-])cloud(?:$|[:-])/iu.test(modelId.trim()));
}

/** Where a local provider runs when its config names no base URL. Only Ollama has a known default. */
export function defaultLocalBaseUrl(providerId: string): string | undefined {
  return providerId.trim().toLowerCase() === "ollama" ? "http://127.0.0.1:11434" : undefined;
}
