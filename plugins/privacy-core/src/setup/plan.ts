// `openclaw privacy setup`: what the wizard writes and runs, as plain data.
// Built from the answers alone, so it can be shown (--dry-run) and tested
// without touching the machine. The executor in run.ts carries it out.

export type PrivateProvider = "tinfoil" | "privatemode";

export type SetupAnswers = {
  provider: PrivateProvider;
  /** Port of the private gateway. */
  privatePort: number;
  /** Version of this plugin, so the private gateway installs the same release. */
  packVersion: string;
  /** npm package specs, or local folders during development. */
  packages: { core: string; provider: string };
  /**
   * Lite mode, for computers without Docker: no sandbox, and the private
   * agent gets no shell, file or browser tools (it can chat and remember).
   */
  lite?: boolean;
};

export const PRIVATE_PROFILE = "private";
export const DEFAULT_PRIVATE_PORT = 19789;
export const SANDBOX_IMAGE = "openclaw-sandbox:bookworm-slim";

export const SANDBOX_DOCKERFILE = `FROM debian:bookworm-slim
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \\
  bash ca-certificates curl git jq python3 ripgrep \\
  && rm -rf /var/lib/apt/lists/*
RUN useradd --create-home --shell /bin/bash sandbox
USER sandbox
WORKDIR /home/sandbox
CMD ["sleep", "infinity"]
`;

type ProviderTemplate = {
  label: string;
  keyName: string;
  keyHelp: string;
  relayPort: number;
  modelName: string;
  residency?: "eu";
  pluginConfig: Record<string, unknown>;
};

export const PROVIDERS: Record<PrivateProvider, ProviderTemplate> = {
  tinfoil: {
    label: "Tinfoil (United States, hardware enclaves)",
    keyName: "TINFOIL_API_KEY",
    keyHelp: "Create a key at https://tinfoil.sh (Dashboard, API keys).",
    relayPort: 19931,
    modelName: "gpt-oss-120b (Tinfoil enclave)",
    pluginConfig: { attestation: { maxAgeMinutes: 15 } },
  },
  privatemode: {
    label: "Privatemode (Germany, EU-only, hardware enclaves)",
    keyName: "PRIVATEMODE_API_KEY",
    keyHelp: "Create a key at https://www.privatemode.ai (Account, API keys).",
    relayPort: 19932,
    modelName: "gpt-oss-120b (Privatemode enclave)",
    residency: "eu",
    pluginConfig: { attestation: { maxAgeMinutes: 15, manifestPin: "strict" } },
  },
};

/**
 * Environment variables for the door (A2A) and the private gateway's own
 * token. OpenClaw's A2A channel takes tokens only as strings with `${VAR}`
 * substitution, not secret-store references, so the values live in each
 * gateway's `.env` file (owner-only permissions).
 */
export const DOOR_TOKENS = {
  inbound: "A2A_INBOX_INBOUND",
  outbound: "A2A_INBOX_OUTBOUND",
} as const;
export const PRIVATE_GATEWAY_TOKEN = "OPENCLAW_PRIVATE_GATEWAY_TOKEN";
const envRef = (name: string) => `\${${name}}`;

const storeRef = (id: string) => ({ source: "store", provider: "default", id });

/** The private gateway's whole config: one `inbox` agent behind the door. */
export function buildPrivateConfig(answers: SetupAnswers): Record<string, unknown> {
  const provider = PROVIDERS[answers.provider];
  return {
    gateway: {
      mode: "local",
      bind: "loopback",
      port: answers.privatePort,
      auth: { mode: "token", token: envRef(PRIVATE_GATEWAY_TOKEN) },
    },
    update: { checkOnStart: false },
    proxy: { proxyUrl: "http://127.0.0.1:19930" },
    browser: { evaluateEnabled: false },
    skills: { workshop: { autonomous: { mode: "off" }, approvalPolicy: "pending" } },
    agents: {
      ownership: "explicit",
      defaults: {
        model: `${answers.provider}/gpt-oss-120b`,
        sandbox: answers.lite
          ? { mode: "off" }
          : { mode: "all", scope: "agent", workspaceAccess: "ro" },
      },
      entries: {
        inbox: {
          name: "Inbox",
          tools: answers.lite
            ? { profile: "minimal", alsoAllow: ["group:memory"], deny: ["gateway"] }
            : {
                profile: "minimal",
                alsoAllow: ["exec", "read", "group:memory"],
                // The sandbox has its own allowlist, without memory tools.
                sandbox: { tools: { alsoAllow: ["group:memory"] } },
              },
          skills: [],
        },
      },
    },
    bindings: [
      { agentId: "inbox", match: { channel: "a2a", peer: { kind: "direct", id: "main-inbox" } } },
    ],
    channels: {
      a2a: {
        enabled: true,
        exposeAgents: ["inbox"],
        peers: { "main-inbox": { token: envRef(DOOR_TOKENS.outbound) } },
      },
    },
    models: {
      providers: {
        [answers.provider]: {
          baseUrl: `http://127.0.0.1:${provider.relayPort}/v1`,
          api: "openai-completions",
          apiKey: storeRef(provider.keyName),
          models: [
            {
              id: "gpt-oss-120b",
              name: provider.modelName,
              reasoning: true,
              input: ["text"],
              contextWindow: 131072,
              maxTokens: 32768,
            },
          ],
        },
      },
    },
    plugins: {
      allow: ["privacy-core", answers.provider, "a2a", "memory-core"],
      entries: {
        "privacy-core": {
          hooks: { allowConversationAccess: true },
          config: {
            mode: "private",
            ...(answers.lite ? { sandbox: "off" } : {}),
            ...(provider.residency ? { residency: provider.residency } : {}),
            boundary: { mode: "summary_only", maxChars: 4000 },
          },
        },
        [answers.provider]: { config: provider.pluginConfig },
      },
    },
  };
}

type PluginEntryDraft = {
  enabled?: boolean;
  hooks?: Record<string, unknown>;
  config?: Record<string, unknown>;
};
type MainDraft = {
  plugins?: { allow?: string[]; entries?: Record<string, PluginEntryDraft | undefined> };
  channels?: Record<string, unknown>;
};

/**
 * Adds the door and privacy-core to the main gateway's config, keeping
 * everything already there. Returns what changed, for the summary.
 */
export function applyMainConfig(draft: MainDraft, answers: SetupAnswers): string[] {
  const changes: string[] = [];
  const plugins = (draft.plugins ??= {});
  const entries = (plugins.entries ??= {});
  const core = (entries["privacy-core"] ??= {});
  if (core.enabled !== true) {
    core.enabled = true;
    changes.push("enabled privacy-core");
  }
  core.config ??= { mode: "standard" };
  // An explicit allowlist would otherwise block what the door needs.
  if (Array.isArray(plugins.allow)) {
    for (const id of ["privacy-core", "a2a"]) {
      if (!plugins.allow.includes(id)) {
        plugins.allow.push(id);
        changes.push(`added ${id} to plugins.allow`);
      }
    }
  }
  const channels = (draft.channels ??= {});
  const a2a = (channels.a2a ??= {}) as {
    enabled?: boolean;
    peers?: Record<string, unknown>;
  };
  if (a2a.enabled !== true) {
    a2a.enabled = true;
    changes.push("enabled the a2a channel");
  }
  const peers = (a2a.peers ??= {});
  const door = {
    url: `http://127.0.0.1:${answers.privatePort}/a2a/v1`,
    token: envRef(DOOR_TOKENS.inbound),
    outboundToken: envRef(DOOR_TOKENS.outbound),
  };
  const existing = peers.inbox as Partial<typeof door> | undefined;
  if (!existing) {
    peers.inbox = door;
    changes.push("added the door to the private inbox agent (channels.a2a.peers.inbox)");
  } else if (
    existing.url !== door.url ||
    existing.token !== door.token ||
    existing.outboundToken !== door.outboundToken
  ) {
    // An older or hand-written door (another port, secret-store references) is replaced.
    peers.inbox = { ...existing, ...door };
    changes.push("updated the door to the private inbox agent (channels.a2a.peers.inbox)");
  }
  return changes;
}

export type SetupStep =
  | { kind: "check-docker" }
  | { kind: "build-sandbox-image" }
  | { kind: "store-secret"; profile: "private"; name: string }
  | { kind: "write-env"; profile: "main" | "private"; names: string[] }
  | { kind: "write-private-config" }
  | { kind: "pause-egress-proxy" }
  | { kind: "install-plugin"; spec: string }
  | { kind: "resume-egress-proxy" }
  | { kind: "update-main-config" }
  | { kind: "install-private-service" }
  | { kind: "restart-main-gateway" }
  | { kind: "verify" }
  | { kind: "check-door" };

/** Every step, in order. Each one is safe to run again. Lite mode needs no Docker. */
export function planSetup(answers: SetupAnswers): SetupStep[] {
  const provider = PROVIDERS[answers.provider];
  return [
    ...(answers.lite
      ? []
      : ([{ kind: "check-docker" }, { kind: "build-sandbox-image" }] as SetupStep[])),
    { kind: "store-secret", profile: "private", name: provider.keyName },
    { kind: "write-env", profile: "main", names: [DOOR_TOKENS.inbound, DOOR_TOKENS.outbound] },
    {
      kind: "write-env",
      profile: "private",
      names: [DOOR_TOKENS.inbound, DOOR_TOKENS.outbound, PRIVATE_GATEWAY_TOKEN],
    },
    { kind: "write-private-config" },
    // Every command of the private profile sends its traffic, npm's included,
    // to privacy-core's proxy, which only runs inside the private gateway and
    // does not allow npm. Installs run with it paused; until it is back on,
    // the privacy rules refuse every private agent run.
    { kind: "pause-egress-proxy" },
    { kind: "install-plugin", spec: answers.packages.core },
    { kind: "install-plugin", spec: answers.packages.provider },
    { kind: "resume-egress-proxy" },
    { kind: "update-main-config" },
    { kind: "install-private-service" },
    { kind: "restart-main-gateway" },
    { kind: "verify" },
    { kind: "check-door" },
  ];
}

/** npm specs for this release, pinned to the running plugin's version. */
export function packageSpecs(provider: PrivateProvider, version: string): SetupAnswers["packages"] {
  return {
    core: `npm:openclaw-private@${version}`,
    provider: `npm:openclaw-private-${provider}@${version}`,
  };
}
