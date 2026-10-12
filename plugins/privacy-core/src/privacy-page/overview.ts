// The facts the Privacy page shows, from both gateways' configs, whether the
// private gateway answers, and its metadata-only audit rows. Pure: no I/O.
import type { PrivacyAuditRow } from "../../../../shared/audit-types.js";
import { resolveProviderTrust } from "../../../../shared/rules/trust.js";
import { resolveAgentPrimaryModel, type HostConfig } from "../../../../shared/rules/validate.js";

export type ModelLabel = { provider: string; providerLabel: string; model: string };

export type PrivacyActivity =
  | { at: string; kind: "answer"; bytes: number }
  | { at: string; kind: "search" | "read" | "calendar"; count: number };

export type PrivacyOverview = {
  mainModel?: ModelLabel;
  inboxAgent: string;
  inboxModel?: ModelLabel;
  privateGateway: "running" | "not_running" | "not_set_up";
  /** From the private gateway's last start check. */
  protection: "on" | "refusing" | "unchecked";
  protectionIssues: number;
  email: { connected: true; address: string } | { connected: false };
  /** Only for attested providers; `at` is missing when no check was recorded yet. */
  enclave?: { providerLabel: string; ok: boolean; at?: string };
  /** Newest first. */
  activity: PrivacyActivity[];
};

export const ACTIVITY_WINDOW_MS = 7 * 86_400_000;
export const ACTIVITY_LIMIT = 20;
const DEFAULT_INBOX_AGENT = "inbox";

const PROVIDER_LABELS: Record<string, string> = {
  anthropic: "Anthropic",
  google: "Google",
  ollama: "Ollama",
  openai: "OpenAI",
  openrouter: "OpenRouter",
  privatemode: "Privatemode",
  tinfoil: "Tinfoil",
  xai: "xAI",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function providerLabel(provider: string): string {
  return PROVIDER_LABELS[provider] ?? provider;
}

function modelLabel(config: unknown, agentId: string | undefined): ModelLabel | undefined {
  if (!isRecord(config)) {
    return undefined;
  }
  const ref = resolveAgentPrimaryModel(config as HostConfig, agentId);
  const slash = ref?.indexOf("/") ?? -1;
  if (!ref || slash <= 0) {
    return undefined;
  }
  const provider = ref.slice(0, slash).toLowerCase();
  // `provider/model@auth-profile`: the auth profile is not part of the model's name.
  const model = ref
    .slice(slash + 1)
    .split("@")[0]
    ?.trim();
  return model ? { provider, providerLabel: providerLabel(provider), model } : undefined;
}

function inboxAgentId(privateConfig: unknown): string {
  const config = isRecord(privateConfig) ? privateConfig : {};
  const channels = isRecord(config.channels) ? config.channels : {};
  const a2a = isRecord(channels.a2a) ? channels.a2a : {};
  const exposed = Array.isArray(a2a.exposeAgents) ? a2a.exposeAgents[0] : undefined;
  if (typeof exposed === "string" && exposed.trim()) {
    return exposed.trim();
  }
  const agents = isRecord(config.agents) ? config.agents : {};
  const entries = isRecord(agents.entries) ? Object.keys(agents.entries).toSorted() : [];
  return entries[0] ?? DEFAULT_INBOX_AGENT;
}

function mailAddress(privateConfig: unknown): string | undefined {
  const config = isRecord(privateConfig) ? privateConfig : {};
  const plugins = isRecord(config.plugins) ? config.plugins : {};
  const entries = isRecord(plugins.entries) ? plugins.entries : {};
  const core = isRecord(entries["privacy-core"]) ? entries["privacy-core"] : {};
  const settings = isRecord(core.config) ? core.config : {};
  const mail = isRecord(settings.mail) ? settings.mail : {};
  return typeof mail.address === "string" && mail.address.trim() ? mail.address.trim() : undefined;
}

function activityOf(row: PrivacyAuditRow): PrivacyActivity | undefined {
  if (row.kind === "boundary_crossing") {
    return { at: row.at, kind: "answer", bytes: row.bytes };
  }
  if (row.kind === "mail" && row.ok) {
    return { at: row.at, kind: row.action, count: row.count };
  }
  return undefined;
}

export function buildPrivacyOverview(input: {
  mainConfig: unknown;
  privateConfig: unknown;
  auditRows: PrivacyAuditRow[];
  privateReachable: boolean;
  now: Date;
}): PrivacyOverview {
  const inboxAgent = inboxAgentId(input.privateConfig);
  const mainModel = modelLabel(input.mainConfig, undefined);
  const inboxModel = modelLabel(input.privateConfig, inboxAgent);
  const privateGateway = !isRecord(input.privateConfig)
    ? "not_set_up"
    : input.privateReachable
      ? "running"
      : "not_running";

  let validation: Extract<PrivacyAuditRow, { kind: "validation" }> | undefined;
  let attestation: Extract<PrivacyAuditRow, { kind: "attestation" }> | undefined;
  const sinceMs = input.now.getTime() - ACTIVITY_WINDOW_MS;
  const activity: PrivacyActivity[] = [];
  for (const row of input.auditRows) {
    if (row.kind === "validation") {
      validation = row;
    } else if (row.kind === "attestation" && row.provider === inboxModel?.provider) {
      attestation = row;
    }
    const atMs = Date.parse(row.at);
    const item = Number.isFinite(atMs) && atMs >= sinceMs ? activityOf(row) : undefined;
    if (item) {
      activity.push(item);
    }
  }

  const address = mailAddress(input.privateConfig);
  const attested = inboxModel ? resolveProviderTrust(inboxModel.provider).attested : false;
  return {
    ...(mainModel ? { mainModel } : {}),
    inboxAgent,
    ...(inboxModel ? { inboxModel } : {}),
    privateGateway,
    protection: !validation ? "unchecked" : validation.ok ? "on" : "refusing",
    protectionIssues: validation?.issues ?? 0,
    email: address ? { connected: true, address } : { connected: false },
    ...(attested && inboxModel
      ? {
          enclave: {
            providerLabel: inboxModel.providerLabel,
            ok: attestation?.ok === true,
            ...(attestation ? { at: attestation.at } : {}),
          },
        }
      : {}),
    activity: activity
      .toSorted((a, b) => Date.parse(b.at) - Date.parse(a.at))
      .slice(0, ACTIVITY_LIMIT),
  };
}
