# Example roster: two gateways, one bot

OpenClaw Private runs two gateways on the same machine, both stock OpenClaw with this pack's plugins. You see one Telegram bot and one dashboard. The private gateway is a background service with no bot of its own.

| Agent      | Gateway | Model                       | Tools                                          | Reached through                |
| ---------- | ------- | --------------------------- | ---------------------------------------------- | ------------------------------ |
| `inbox`    | private | `tinfoil/gpt-oss-120b`      | sandboxed shell and files, no extra skills yet | `ask_private_agent` from chief |
| `research` | main    | `anthropic/claude-opus-5`   | web search, files                              | Telegram                       |
| `builder`  | main    | `anthropic/claude-sonnet-5` | code, sandbox                                  | Telegram                       |
| `chief`    | main    | `anthropic/claude-opus-5`   | messaging other agents, `ask_private_agent`    | Telegram                       |

Plugins per gateway:

| Gateway | Pack plugins installed | Why                                                                                  |
| ------- | ---------------------- | ------------------------------------------------------------------------------------ |
| main    | `privacy-core`         | The `ask_private_agent` tool, the action policy, `openclaw privacy` commands         |
| private | all three              | Run gate, egress proxy, the door filter, and the attested Tinfoil/Privatemode relays |

A private `browser` agent is planned but not available yet: OpenClaw's sandboxed browser gets its own container network, which would bypass the egress proxy, so private mode refuses it until it can run behind the proxy.

`openclaw privacy setup` writes both configs below for you; they are shown here for reference and for the manual route.

Provider keys are SecretRefs to each gateway's own secret store (`openclaw secrets store set NAME`, with `--profile private` for the private one); never literals. OpenClaw's A2A channel only accepts tokens as `${VARIABLES}`, so the two door tokens and the private gateway token live in each gateway's `.env` file (`~/.openclaw/.env`, `~/.openclaw-private/.env`, owner-only). The two door tokens must hold the same values on both sides.

## Main gateway: `~/.openclaw/openclaw.json`

```json5
{
  agents: {
    ownership: "explicit",
    defaults: { sandbox: { mode: "non-main" } },
    entries: {
      chief: {
        name: "Chief of staff",
        model: "anthropic/claude-opus-5",
        tools: { profile: "messaging", alsoAllow: ["ask_private_agent", "sessions_send"] },
        subagents: { allowAgents: ["research", "builder"] },
        skills: [],
      },
      research: {
        name: "Research",
        model: "anthropic/claude-opus-5",
        tools: { profile: "coding", alsoAllow: ["web_search", "web_fetch"] },
        skills: [],
      },
      builder: {
        name: "Builder",
        model: "anthropic/claude-sonnet-5",
        tools: { profile: "coding" },
        sandbox: { mode: "all" },
        skills: [],
      },
    },
  },
  bindings: [{ agentId: "chief", match: { channel: "telegram" } }],
  channels: {
    telegram: {
      enabled: true,
      botToken: { source: "store", provider: "default", id: "TELEGRAM_BOT_TOKEN" },
    },
    a2a: {
      enabled: true,
      peers: {
        inbox: {
          url: "http://127.0.0.1:19789/a2a/v1",
          // The A2A channel reads tokens from the environment (~/.openclaw/.env).
          token: "${A2A_INBOX_INBOUND}",
          outboundToken: "${A2A_INBOX_OUTBOUND}",
        },
      },
    },
  },
  models: {
    providers: {
      anthropic: { apiKey: { source: "store", provider: "default", id: "ANTHROPIC_API_KEY" } },
    },
  },
  // Named plugins only. Nothing third-party runs unless you add it here.
  plugins: {
    allow: ["anthropic", "telegram", "a2a", "privacy-core", "brave", "browser", "memory-core"],
    entries: { "privacy-core": { config: { mode: "standard" } } },
  },
}
```

## Private gateway: `~/.openclaw-private/openclaw.json` (profile `private`, port 19789)

```json5
{
  gateway: {
    mode: "local",
    bind: "loopback",
    port: 19789,
    auth: { mode: "token", token: "${OPENCLAW_PRIVATE_GATEWAY_TOKEN}" },
  },
  // Every outbound connection of this gateway goes through privacy-core's allowlist.
  proxy: { proxyUrl: "http://127.0.0.1:19930" },
  browser: { evaluateEnabled: false },
  // Skill approval: Workshop changes wait for you (openclaw privacy skills approve).
  skills: { workshop: { autonomous: { mode: "off" }, approvalPolicy: "pending" } },
  agents: {
    ownership: "explicit",
    defaults: {
      model: "tinfoil/gpt-oss-120b",
      // "ro": the agent cannot rewrite its own skills or instructions.
      sandbox: { mode: "all", scope: "agent", workspaceAccess: "ro" },
    },
    entries: {
      inbox: {
        name: "Inbox",
        tools: { profile: "minimal", alsoAllow: ["exec", "read"] },
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
      peers: {
        // Read from ~/.openclaw-private/.env, same value as on the main side.
        "main-inbox": { token: "${A2A_INBOX_OUTBOUND}" },
      },
    },
  },
  models: {
    providers: {
      // Stock OpenClaw requires the full block for a plugin provider.
      // The base URL is the plugin's loopback relay, which attests before sending.
      tinfoil: {
        baseUrl: "http://127.0.0.1:19931/v1",
        api: "openai-completions",
        apiKey: { source: "store", provider: "default", id: "TINFOIL_API_KEY" },
        models: [
          {
            id: "gpt-oss-120b",
            name: "gpt-oss-120b (Tinfoil enclave)",
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
    allow: ["privacy-core", "tinfoil", "a2a", "memory-core"],
    entries: {
      "privacy-core": {
        hooks: { allowConversationAccess: true },
        config: {
          mode: "private",
          egress: {
            allow: ["gmail.googleapis.com", "www.googleapis.com", "oauth2.googleapis.com"],
          },
          boundary: { mode: "summary_only", maxChars: 4000 },
          // Default private policy: every write-shaped action waits for your approval; reads are free.
        },
      },
      tinfoil: { config: { attestation: { maxAgeMinutes: 15 } } },
    },
  },
}
```

`plugins install -l` adds a `plugins.load.paths` entry for each pack plugin; keep it.

## What the private gateway refuses

privacy-core cannot stop a gateway from starting, so it refuses at the two places that matter:

Rules: attested or loopback models only (no Ollama cloud models), attested providers only through their relay, the OpenClaw agent runtime only, no plaintext API keys, sandbox `all` everywhere with container network `none` and no sandboxed browser, an explicit `skills` list on every agent, sandbox workspace access `none` or `ro`, Skill Workshop set to `off` (or `propose`) with `approvalPolicy: "pending"`, every skill in the gateway's skill folders approved by fingerprint, A2A as the only channel, plugins from a fixed list with privacy-core enabled, `proxy.proxyUrl` pointing at privacy-core, no host-browser control or profile import, `browser.evaluateEnabled: false`, message auditing off.

While any rule is broken, four things refuse independently, so no single missing hook turns the protection off:

- **Agent runs:** refused with a pointer to `openclaw privacy status`, which lists each problem and the key to fix.
- **Tool calls:** every one is refused.
- **Model requests:** the attested relays answer 503 and send nothing.
- **Outbound connections:** the egress proxy refuses all of them.

When the config is safe, the proxy still lets through only HTTPS to allowlisted public hosts. If privacy-core is not running, the proxy is missing and nothing leaves the machine. Runs are also refused while the relay or the proxy failed to start, for example because another program holds its port.
