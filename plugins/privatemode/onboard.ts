// Privatemode setup module handles plugin onboarding behavior.
import { createModelCatalogPresetAppliers } from "openclaw/plugin-sdk/provider-onboard";
import {
  PRIVATEMODE_BASE_URL,
  PRIVATEMODE_DEFAULT_MODEL_REF,
  PRIVATEMODE_MODEL_CATALOG,
} from "./models.js";

export const { applyConfig: applyPrivatemodeConfig } = createModelCatalogPresetAppliers<[]>({
  primaryModelRef: PRIVATEMODE_DEFAULT_MODEL_REF,
  resolveParams: (cfg) => ({
    providerId: "privatemode",
    api: "openai-completions",
    baseUrl: PRIVATEMODE_BASE_URL,
    catalogModels: cfg.models?.mode === "replace" ? structuredClone(PRIVATEMODE_MODEL_CATALOG) : [],
    aliases: [{ modelRef: PRIVATEMODE_DEFAULT_MODEL_REF, alias: "gpt-oss-120b" }],
  }),
});
