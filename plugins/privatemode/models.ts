import {
  buildManifestModelProviderConfig,
  readManifestProviderDefaultModelRef,
} from "openclaw/plugin-sdk/provider-catalog-shared";
import type {
  ModelDefinitionConfig,
  ModelProviderConfig,
} from "openclaw/plugin-sdk/provider-model-shared";
import manifest from "./openclaw.plugin.json" with { type: "json" };

const PRIVATEMODE_MANIFEST_CATALOG = manifest.modelCatalog.providers.privatemode;

/** Loopback relay the shared transport talks to; the relay forwards through the attested SDK. */
export const PRIVATEMODE_BASE_URL = PRIVATEMODE_MANIFEST_CATALOG.baseUrl;
export const PRIVATEMODE_DEFAULT_RELAY_PORT = 19932;
/** Nominal upstream base; the SDK routes by path through its own attested transport. */
export const PRIVATEMODE_UPSTREAM_BASE_URL = "https://api.privatemode.ai/v1";
export const PRIVATEMODE_DEFAULT_MODEL_REF = readManifestProviderDefaultModelRef(
  manifest,
  "privatemode",
)!;

/** Network-free fallback catalog; the live list (through the attested transport) wins. */
export const PRIVATEMODE_MODEL_CATALOG: ModelDefinitionConfig[] = buildManifestModelProviderConfig({
  providerId: "privatemode",
  catalog: PRIVATEMODE_MANIFEST_CATALOG,
}).models;

export function buildStaticPrivatemodeProvider(): ModelProviderConfig {
  return {
    baseUrl: PRIVATEMODE_BASE_URL,
    api: "openai-completions",
    models: structuredClone(PRIVATEMODE_MODEL_CATALOG),
  };
}
