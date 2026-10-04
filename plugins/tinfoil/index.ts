// Tinfoil plugin entrypoint: an attested-enclave model provider.
//
// Every model request goes from OpenClaw to a loopback relay owned by this
// plugin, and from there through the SDK's SecureClient, which verifies the
// enclave's hardware attestation against the published, Sigstore-signed build
// before sending and HPKE-seals the request body to that enclave. If
// verification fails or cannot run, the request is never sent.
import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";
import { createAttestedRelay, type AttestedRelay } from "../../shared/attested-relay.js";
import { privacyConfigRefusal } from "../../shared/rules/guard.js";
import { authoredConfig } from "../../shared/rules/source-config.js";
import {
  buildStaticTinfoilProvider,
  TINFOIL_DEFAULT_RELAY_PORT,
  TINFOIL_MODEL_DISCOVERY_OPTIONS,
  TINFOIL_UPSTREAM_BASE_URL,
} from "./models.js";
import { applyTinfoilConfig } from "./onboard.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };
import {
  createTinfoilAttestedTransport,
  TINFOIL_DEFAULT_ATTESTATION_MAX_AGE_MS,
  type TinfoilAttestedTransport,
} from "./src/attested-transport.js";
import { loadOrCreateTinfoilUserCacheSecret } from "./src/user-cache-secret.js";

const PROVIDER_ID = "tinfoil";

type TinfoilPluginConfig = {
  attestation?: { maxAgeMinutes?: number };
  relay?: { port?: number };
};

function resolveMaxAgeMs(config: TinfoilPluginConfig | undefined): number {
  const minutes = config?.attestation?.maxAgeMinutes;
  return typeof minutes === "number" && Number.isFinite(minutes) && minutes >= 1
    ? minutes * 60_000
    : TINFOIL_DEFAULT_ATTESTATION_MAX_AGE_MS;
}

export default defineSingleProviderPluginEntry({
  id: PROVIDER_ID,
  name: "Tinfoil Provider",
  description: "Attested confidential-compute inference through Tinfoil enclaves",
  manifest,
  provider: (api) => {
    const pluginConfig = api.pluginConfig as TinfoilPluginConfig | undefined;
    let transport: TinfoilAttestedTransport | undefined;
    const resolveTransport = (): TinfoilAttestedTransport => {
      transport ??= createTinfoilAttestedTransport({
        configuredBaseUrl: TINFOIL_UPSTREAM_BASE_URL,
        maxAgeMs: resolveMaxAgeMs(pluginConfig),
        userCacheSecret: loadOrCreateTinfoilUserCacheSecret(),
      });
      return transport;
    };
    // The shared OpenAI-compatible transport talks to this loopback relay; the
    // relay sends through the attested client only. Stock OpenClaw needs no hook.
    let relay: AttestedRelay | undefined;
    api.registerService({
      id: "tinfoil-attested-relay",
      start: async () => {
        relay = createAttestedRelay({
          provider: PROVIDER_ID,
          serviceId: "tinfoil-attested-relay",
          // Refuse everything while the privacy config is unsafe, even if
          // privacy-core's run gate is not delivered.
          guard: () => privacyConfigRefusal(authoredConfig(api.config)),
          upstreamBaseUrl: TINFOIL_UPSTREAM_BASE_URL,
          fetch: (input, init) => resolveTransport().fetch(input, init),
          port: pluginConfig?.relay?.port ?? TINFOIL_DEFAULT_RELAY_PORT,
          onError: (message) => api.logger.warn(message),
        });
        api.logger.info(`tinfoil attested relay listening at ${await relay.start()}`);
      },
      stop: async () => {
        await relay?.stop();
        relay = undefined;
      },
    });
    return {
      label: "Tinfoil",
      docsPath: "/providers/tinfoil",
      manifestAuth: {
        applyConfig: applyTinfoilConfig,
        noteMessage: [
          "Tinfoil runs open models inside hardware-attested enclaves (AMD SEV-SNP).",
          "OpenClaw verifies the enclave against the published build before every connection and encrypts request bodies to it.",
          "Get your API key at: https://tinfoil.sh",
        ].join("\n"),
        noteTitle: "Tinfoil",
      },
      catalog: {
        discoveryMode: "strict",
        buildProvider: buildStaticTinfoilProvider,
        liveModelDiscovery: TINFOIL_MODEL_DISCOVERY_OPTIONS,
      },
    };
  },
});
