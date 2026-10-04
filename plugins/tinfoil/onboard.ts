// Tinfoil setup module handles plugin onboarding behavior.
import { createModelCatalogPresetAppliers } from "openclaw/plugin-sdk/provider-onboard";
import { TINFOIL_BASE_URL, TINFOIL_DEFAULT_MODEL_REF, TINFOIL_MODEL_CATALOG } from "./models.js";

export const { applyConfig: applyTinfoilConfig } = createModelCatalogPresetAppliers<[]>({
  primaryModelRef: TINFOIL_DEFAULT_MODEL_REF,
  resolveParams: (cfg) => ({
    providerId: "tinfoil",
    api: "openai-completions",
    baseUrl: TINFOIL_BASE_URL,
    catalogModels: cfg.models?.mode === "replace" ? structuredClone(TINFOIL_MODEL_CATALOG) : [],
    aliases: [{ modelRef: TINFOIL_DEFAULT_MODEL_REF, alias: "gpt-oss-120b" }],
  }),
});
