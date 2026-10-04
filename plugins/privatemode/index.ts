// Privatemode plugin entrypoint: an attested-enclave model provider in the EU.
//
// Every model request goes from OpenClaw to a loopback relay owned by this
// plugin, and from there through the privatemode-ai SDK, which verifies the
// deployment's attestation against a manifest of reference values before
// establishing an encryption secret and sending anything. The verifier WASM is
// pinned by hash and the manifest can be pinned per gateway.
import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";
import { createAttestedRelay, type AttestedRelay } from "../../shared/attested-relay.js";
import { privacyConfigRefusal } from "../../shared/rules/guard.js";
import { authoredConfig } from "../../shared/rules/source-config.js";
import {
  buildStaticPrivatemodeProvider,
  PRIVATEMODE_DEFAULT_RELAY_PORT,
  PRIVATEMODE_UPSTREAM_BASE_URL,
} from "./models.js";
import { applyPrivatemodeConfig } from "./onboard.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };
import {
  bearerToken,
  createPrivatemodeAttestedTransport,
  runWithPrivatemodeCredential,
  PRIVATEMODE_DEFAULT_ATTESTATION_MAX_AGE_MS,
  type PrivatemodeAttestedTransport,
} from "./src/attested-transport.js";
import {
  readPinnedPrivatemodeManifest,
  writePinnedPrivatemodeManifest,
} from "./src/manifest-pin.js";

const PROVIDER_ID = "privatemode";

type PrivatemodePluginConfig = {
  attestation?: { maxAgeMinutes?: number; manifestPin?: "auto" | "strict" };
  relay?: { port?: number };
};

function resolveMaxAgeMs(config: PrivatemodePluginConfig | undefined): number {
  const minutes = config?.attestation?.maxAgeMinutes;
  return typeof minutes === "number" && Number.isFinite(minutes) && minutes >= 1
    ? minutes * 60_000
    : PRIVATEMODE_DEFAULT_ATTESTATION_MAX_AGE_MS;
}

export default defineSingleProviderPluginEntry({
  id: PROVIDER_ID,
  name: "Privatemode Provider",
  description: "Attested confidential-compute inference through Privatemode (Edgeless Systems)",
  manifest,
  provider: (api) => {
    let transport: PrivatemodeAttestedTransport | undefined;
    const pluginConfig = api.pluginConfig as PrivatemodePluginConfig | undefined;
    const resolveTransport = (): PrivatemodeAttestedTransport => {
      transport ??= createPrivatemodeAttestedTransport({
        maxAgeMs: resolveMaxAgeMs(pluginConfig),
        manifestPin: pluginConfig?.attestation?.manifestPin ?? "auto",
        pinnedManifest: readPinnedPrivatemodeManifest(),
        persistManifest: (bytes) => writePinnedPrivatemodeManifest(bytes),
      });
      return transport;
    };
    // The shared OpenAI-compatible transport talks to this loopback relay; the
    // relay sends through the attested SDK only. Stock OpenClaw needs no hook.
    let relay: AttestedRelay | undefined;
    api.registerService({
      id: "privatemode-attested-relay",
      start: async () => {
        relay = createAttestedRelay({
          provider: PROVIDER_ID,
          serviceId: "privatemode-attested-relay",
          // Refuse everything while the privacy config is unsafe, even if
          // privacy-core's run gate is not delivered.
          guard: () => privacyConfigRefusal(authoredConfig(api.config)),
          upstreamBaseUrl: PRIVATEMODE_UPSTREAM_BASE_URL,
          // Each request is authenticated with the key its caller sent.
          fetch: (input, init) =>
            runWithPrivatemodeCredential(bearerToken(init?.headers), () =>
              resolveTransport().fetch(input, init),
            ),
          port: pluginConfig?.relay?.port ?? PRIVATEMODE_DEFAULT_RELAY_PORT,
          onError: (message) => api.logger.warn(message),
        });
        api.logger.info(`privatemode attested relay listening at ${await relay.start()}`);
      },
      stop: async () => {
        await relay?.stop();
        relay = undefined;
      },
    });
    return {
      label: "Privatemode",
      docsPath: "/providers/privatemode",
      manifestAuth: {
        applyConfig: applyPrivatemodeConfig,
        noteMessage: [
          "Privatemode (Edgeless Systems, Germany) runs open models inside attested confidential-compute enclaves.",
          "OpenClaw verifies the deployment against its manifest before every connection and encrypts requests to it.",
          "Get your API key at: https://www.privatemode.ai",
        ].join("\n"),
        noteTitle: "Privatemode",
      },
      catalog: {
        discoveryMode: "strict",
        buildProvider: buildStaticPrivatemodeProvider,
      },
    };
  },
});
