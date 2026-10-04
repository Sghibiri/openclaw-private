// Declarations for the OpenClaw plugin SDK subpaths this pack calls that the
// published `openclaw` package ships without .d.ts files (checked on 2026.9.6).
// Only what the pack uses is declared; runtime behavior comes from the host.
declare module "openclaw/plugin-sdk/provider-entry" {
  import type {
    OpenClawPluginApi,
    OpenClawPluginDefinition,
  } from "openclaw/plugin-sdk/plugin-entry";

  export function defineSingleProviderPluginEntry(options: {
    id: string;
    name: string;
    description: string;
    manifest: unknown;
    provider: (api: OpenClawPluginApi) => { label: string } & Record<string, unknown>;
  }): OpenClawPluginDefinition;
}

declare module "openclaw/plugin-sdk/provider-model-shared" {
  export type ModelDefinitionConfig = { id: string; name?: string } & Record<string, unknown>;
  export type ModelProviderConfig = {
    baseUrl: string;
    api: string;
    models: ModelDefinitionConfig[];
  } & Record<string, unknown>;
}

declare module "openclaw/plugin-sdk/provider-catalog-shared" {
  import type { ModelDefinitionConfig } from "openclaw/plugin-sdk/provider-model-shared";

  export function buildManifestModelProviderConfig(params: {
    providerId: string;
    catalog: unknown;
  }): { models: ModelDefinitionConfig[] };
  export function readManifestProviderDefaultModelRef(
    manifest: unknown,
    providerId: string,
  ): string | undefined;
}

declare module "openclaw/plugin-sdk/provider-onboard" {
  import type { OpenClawConfig } from "openclaw/plugin-sdk/plugin-entry";

  export function createModelCatalogPresetAppliers<TArgs extends unknown[]>(params: {
    primaryModelRef: string;
    resolveParams: (cfg: OpenClawConfig, ...args: TArgs) => unknown;
  }): { applyConfig: (cfg: OpenClawConfig, ...args: TArgs) => OpenClawConfig };
}
