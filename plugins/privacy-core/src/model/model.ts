// `openclaw privacy model [set <id>]`: which enclave model the private Inbox
// agent uses. The list comes live from the provider's attested relay on the
// private gateway (public metadata, no key); switching adds the model to the
// private gateway's catalog, points the Inbox agent at it, then restarts and
// checks the gateway. The provider, its relay and its trust never change here.
import { Type } from "typebox";
import { Check } from "typebox/value";
import { expectedRelayBaseUrl, resolveProviderTrust } from "../../../../shared/rules/trust.js";
import { resolveAgentPrimaryModel, type HostConfig } from "../../../../shared/rules/validate.js";
import { readPrivateConfig, restartAndVerify, type MailCliDeps } from "../mail/connect.js";

export type ModelCliDeps = MailCliDeps & {
  fetchJson: (url: string, signal: AbortSignal) => Promise<unknown>;
};

export type EnclaveModel = {
  id: string;
  name: string;
  contextWindow?: number;
  toolCalling: boolean;
  reasoning: boolean;
  /** The provider takes `reasoning_effort` at the top level, the way OpenClaw sends it. */
  reasoningEffortTopLevel: boolean;
  experimental: boolean;
  inputPrice?: number;
  outputPrice?: number;
};

export type EnclaveModelList = {
  providerId: string;
  providerLabel: string;
  inboxAgent: string;
  currentRef: string;
  models: EnclaveModel[];
};

const DEFAULT_INBOX_AGENT = "inbox";
const DEFAULT_CONTEXT_WINDOW = 131_072;
const DEFAULT_MAX_TOKENS = 32_768;
const PROVIDER_LABELS: Record<string, string> = { tinfoil: "Tinfoil", privatemode: "Privatemode" };

const LiveModelList = Type.Object({ data: Type.Array(Type.Unknown()) });
const LiveModel = Type.Object({
  id: Type.String({ minLength: 1, maxLength: 200 }),
  type: Type.Optional(Type.String()),
  name: Type.Optional(Type.String({ maxLength: 200 })),
  context_window: Type.Optional(Type.Number({ minimum: 1 })),
  tool_calling: Type.Optional(Type.Boolean()),
  reasoning: Type.Optional(Type.Boolean()),
  experimental: Type.Optional(Type.Boolean()),
  pricing: Type.Optional(
    Type.Object({
      inputTokenPricePer1M: Type.Optional(Type.Number()),
      outputTokenPricePer1M: Type.Optional(Type.Number()),
    }),
  ),
  reasoning_params: Type.Optional(Type.Unknown()),
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function takesTopLevelReasoningEffort(params: unknown): boolean {
  const routes = isRecord(params) && isRecord(params.params) ? params.params : {};
  const chat = routes["/v1/chat/completions"];
  const enable = isRecord(chat) ? chat.enable : undefined;
  return isRecord(enable) && Object.hasOwn(enable, "reasoning_effort");
}

/** Chat models from an OpenAI-style `/v1/models` answer, sorted by id. */
export function parseEnclaveModels(raw: unknown): EnclaveModel[] {
  if (!Check(LiveModelList, raw)) {
    throw new Error("the enclave relay's answer is not a model list");
  }
  const models: EnclaveModel[] = [];
  for (const item of raw.data) {
    if (!Check(LiveModel, item) || (item.type !== undefined && item.type !== "chat")) {
      continue;
    }
    models.push({
      id: item.id,
      name: item.name?.trim() || item.id,
      ...(item.context_window !== undefined ? { contextWindow: item.context_window } : {}),
      toolCalling: item.tool_calling === true,
      reasoning: item.reasoning === true,
      reasoningEffortTopLevel: takesTopLevelReasoningEffort(item.reasoning_params),
      experimental: item.experimental === true,
      ...(item.pricing?.inputTokenPricePer1M !== undefined
        ? { inputPrice: item.pricing.inputTokenPricePer1M }
        : {}),
      ...(item.pricing?.outputTokenPricePer1M !== undefined
        ? { outputPrice: item.pricing.outputTokenPricePer1M }
        : {}),
    });
  }
  return models.toSorted((a, b) => a.id.localeCompare(b.id));
}

/**
 * The private gateway's catalog entry for a model. Thinking controls are only
 * declared when the provider takes `reasoning_effort` the way OpenClaw sends it;
 * otherwise the model runs with its own default.
 */
export function catalogEntry(model: EnclaveModel, providerLabel: string) {
  return {
    id: model.id,
    name: `${model.name} (${providerLabel} enclave)`,
    reasoning: model.reasoning && model.reasoningEffortTopLevel,
    input: ["text"],
    contextWindow: model.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
    maxTokens: DEFAULT_MAX_TOKENS,
  };
}

function inboxAgentId(config: Record<string, unknown>): string {
  const channels = isRecord(config.channels) ? config.channels : {};
  const a2a = isRecord(channels.a2a) ? channels.a2a : {};
  const exposed = Array.isArray(a2a.exposeAgents) ? a2a.exposeAgents[0] : undefined;
  return typeof exposed === "string" && exposed.trim() ? exposed.trim() : DEFAULT_INBOX_AGENT;
}

async function readModelSetup(deps: ModelCliDeps) {
  const config: unknown = await readPrivateConfig(deps);
  if (!isRecord(config)) {
    throw new Error(`${deps.privateConfigPath} is not a config object`);
  }
  const inboxAgent = inboxAgentId(config);
  const currentRef = resolveAgentPrimaryModel(config as HostConfig, inboxAgent);
  const slash = currentRef?.indexOf("/") ?? -1;
  if (!currentRef || slash <= 0) {
    throw new Error(
      "the private gateway has no default model; run: openclaw --profile private privacy status",
    );
  }
  const providerId = currentRef.slice(0, slash).toLowerCase();
  const trust = resolveProviderTrust(providerId);
  const relay = expectedRelayBaseUrl(trust, config.plugins as HostConfig["plugins"]);
  if (!relay) {
    throw new Error(
      `the Inbox agent's model "${currentRef}" is not an enclave model, so there is no enclave list to choose from`,
    );
  }
  return {
    config,
    inboxAgent,
    currentRef,
    providerId,
    providerLabel: PROVIDER_LABELS[providerId] ?? providerId,
    relay,
  };
}

async function fetchModels(
  deps: ModelCliDeps,
  setup: Awaited<ReturnType<typeof readModelSetup>>,
  signal: AbortSignal,
): Promise<EnclaveModel[]> {
  let raw: unknown;
  try {
    raw = await deps.fetchJson(`${setup.relay}/models`, signal);
  } catch (error) {
    throw new Error(
      `the private gateway's ${setup.providerLabel} relay did not answer (${error instanceof Error ? error.message : String(error)}); start it with: openclaw --profile private gateway start`,
    );
  }
  return parseEnclaveModels(raw);
}

export async function listEnclaveModels(
  deps: ModelCliDeps,
  signal: AbortSignal,
): Promise<EnclaveModelList> {
  const setup = await readModelSetup(deps);
  return {
    providerId: setup.providerId,
    providerLabel: setup.providerLabel,
    inboxAgent: setup.inboxAgent,
    currentRef: setup.currentRef,
    models: await fetchModels(deps, setup, signal),
  };
}

function contextLabel(tokens: number | undefined): string {
  if (tokens === undefined) {
    return "? context";
  }
  return tokens >= 1_048_576
    ? `${Math.round(tokens / 1_048_576)}M context`
    : `${Math.round(tokens / 1024)}K context`;
}

function priceLabel(model: EnclaveModel): string {
  return model.inputPrice !== undefined && model.outputPrice !== undefined
    ? `$${model.inputPrice.toFixed(2)} in / $${model.outputPrice.toFixed(2)} out per 1M tokens`
    : "price not listed";
}

export function formatModelList(list: EnclaveModelList): string[] {
  const current = list.currentRef.slice(list.providerId.length + 1);
  const usable = list.models.filter((model) => model.toolCalling || model.id === current);
  const idWidth = Math.max(...usable.map((model) => model.id.length), 2);
  const nameWidth = Math.max(...usable.map((model) => model.name.length), 4);
  const contextWidth = Math.max(
    ...usable.map((model) => contextLabel(model.contextWindow).length),
    9,
  );
  const lines = [
    `The Inbox agent uses: ${current} on ${list.providerLabel} (${list.currentRef})`,
    "",
    `Models in the ${list.providerLabel} enclave that can use tools (the Inbox agent reads email with tools):`,
  ];
  for (const model of usable) {
    const notes = [
      model.experimental ? "experimental" : "",
      model.id === current ? "(in use)" : "",
    ].filter(Boolean);
    lines.push(
      `${model.id === current ? "*" : " "} ${model.id.padEnd(idWidth)}  ${model.name.padEnd(nameWidth)}  ${contextLabel(model.contextWindow).padEnd(contextWidth)}  ${priceLabel(model)}${notes.length ? `  ${notes.join(" ")}` : ""}`,
    );
  }
  lines.push("", "Switch with: openclaw privacy model set <id>");
  return lines;
}

function withPrimary(value: unknown, ref: string): unknown {
  return isRecord(value) ? { ...value, primary: ref } : ref;
}

export async function setEnclaveModel(
  modelId: string,
  deps: ModelCliDeps,
  signal: AbortSignal,
): Promise<{ changed: boolean; ref: string; warnings: string[] }> {
  const setup = await readModelSetup(deps);
  const models = await fetchModels(deps, setup, signal);
  const id = modelId.trim();
  const model = models.find((candidate) => candidate.id === id);
  if (!model) {
    const usable = models.filter((candidate) => candidate.toolCalling).map((m) => m.id);
    throw new Error(
      `${setup.providerLabel} does not offer "${id}" right now. Choose one of: ${usable.join(", ")}`,
    );
  }
  if (!model.toolCalling) {
    throw new Error(
      `${model.name} cannot use tools, and the Inbox agent reads email with tools; choose another model (openclaw privacy model)`,
    );
  }
  const ref = `${setup.providerId}/${model.id}`;
  if (ref === setup.currentRef) {
    deps.log(`  ok  the Inbox agent already uses ${ref}; nothing changed`);
    return { changed: false, ref, warnings: [] };
  }

  const { config } = setup;
  const providers =
    isRecord(config.models) && isRecord(config.models.providers)
      ? config.models.providers
      : undefined;
  const provider = providers?.[setup.providerId];
  if (!isRecord(provider) || !Array.isArray(provider.models)) {
    throw new Error(
      `the private config has no models.providers.${setup.providerId} catalog; run: openclaw privacy setup`,
    );
  }
  if (!provider.models.some((entry) => isRecord(entry) && entry.id === model.id)) {
    provider.models.push(catalogEntry(model, setup.providerLabel));
    deps.log(`  ok  added ${model.name} to the private gateway's ${setup.providerLabel} models`);
  }

  const agents = isRecord(config.agents) ? config.agents : {};
  const entries = isRecord(agents.entries) ? agents.entries : {};
  const inbox = entries[setup.inboxAgent];
  if (isRecord(inbox) && inbox.model !== undefined) {
    inbox.model = withPrimary(inbox.model, ref);
  } else {
    const defaults = isRecord(agents.defaults) ? agents.defaults : {};
    defaults.model = withPrimary(defaults.model, ref);
    agents.defaults = defaults;
    config.agents = agents;
  }
  await deps.writeFileAtomic(deps.privateConfigPath, `${JSON.stringify(config, null, 2)}\n`);
  deps.log(`  ok  the Inbox agent now uses ${ref}`);
  return { changed: true, ref, warnings: await restartAndVerify(deps) };
}
