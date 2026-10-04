import {
  buildManifestModelProviderConfig,
  readManifestProviderDefaultModelRef,
} from "openclaw/plugin-sdk/provider-catalog-shared";
import type {
  ModelDefinitionConfig,
  ModelProviderConfig,
} from "openclaw/plugin-sdk/provider-model-shared";
import manifest from "./openclaw.plugin.json" with { type: "json" };

const TINFOIL_MANIFEST_CATALOG = manifest.modelCatalog.providers.tinfoil;

/** Loopback relay the shared transport talks to; the relay forwards through the attested client. */
export const TINFOIL_BASE_URL = TINFOIL_MANIFEST_CATALOG.baseUrl;
export const TINFOIL_DEFAULT_RELAY_PORT = 19931;
/** Upstream base the attested client accepts; requests are rebased onto the attested router. */
export const TINFOIL_UPSTREAM_BASE_URL = "https://inference.tinfoil.sh/v1";
export const TINFOIL_DEFAULT_MODEL_REF = readManifestProviderDefaultModelRef(manifest, "tinfoil")!;

/** Network-free fallback catalog; the live list from the enclave wins when reachable. */
export const TINFOIL_MODEL_CATALOG: ModelDefinitionConfig[] = buildManifestModelProviderConfig({
  providerId: "tinfoil",
  catalog: TINFOIL_MANIFEST_CATALOG,
}).models;

export const TINFOIL_MODEL_DISCOVERY_OPTIONS = {
  // The model list is public metadata, fetched without credentials through the
  // relay, so even discovery goes through the attested transport.
  authentication: "none",
  endpointUrl: { url: `${TINFOIL_BASE_URL}/models`, requireBaseUrl: TINFOIL_BASE_URL },
  timeoutMs: 10_000,
  ttlMs: 60_000,
} as const;

export function buildStaticTinfoilProvider(): ModelProviderConfig {
  return {
    baseUrl: TINFOIL_BASE_URL,
    api: "openai-completions",
    models: structuredClone(TINFOIL_MODEL_CATALOG),
  };
}
