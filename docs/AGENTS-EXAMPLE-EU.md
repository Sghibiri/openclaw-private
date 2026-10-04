# Example roster, EU only

Same roster as [AGENTS-EXAMPLE](AGENTS-EXAMPLE.md), for a customer whose contract says "EU only". One setting per gateway changes the providers: `residency: "eu"` in privacy-core's config.

| Agent               | Gateway | Model                          | Note                                                                     |
| ------------------- | ------- | ------------------------------ | ------------------------------------------------------------------------ |
| `inbox`             | private | `privatemode/gpt-oss-120b`     | Privatemode, Edgeless Systems (Germany), attested enclaves               |
| `research`, `chief` | main    | `mistral/mistral-large-latest` | placeholder: confirm the EU region claim with the vendor before using it |
| `builder`           | main    | `mistral/codestral-latest`     | placeholder, as above                                                    |

With `residency: "eu"`, both gateways refuse agent runs on a provider outside the EU. The private gateway accepts `privatemode` (EU, attested) or a loopback Ollama. The main gateway accepts any provider whose region is `eu` or `local`. A provider this pack does not know, such as `mistral`, is refused until you declare its region under `providers.<id>.region`, after confirming the processing region with the vendor. The declaration can only set a region. It can never mark a provider attested, so it never admits a provider into the private gateway.

## Private gateway differences

Install the `privatemode` plugin instead of `tinfoil` (`openclaw --profile private plugins install -l ~/openclaw-private/plugins/privatemode`), then:

```json5
{
  agents: {
    defaults: {
      model: "privatemode/gpt-oss-120b",
      // "ro": the agent cannot rewrite its own skills or instructions.
      sandbox: { mode: "all", scope: "agent", workspaceAccess: "ro" },
    },
  },
  models: {
    providers: {
      privatemode: {
        baseUrl: "http://127.0.0.1:19932/v1",
        api: "openai-completions",
        apiKey: { source: "store", provider: "default", id: "PRIVATEMODE_API_KEY" },
        models: [
          {
            id: "gpt-oss-120b",
            name: "gpt-oss-120b (Privatemode enclave)",
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
    allow: ["privacy-core", "privatemode", "a2a", "memory-core"],
    entries: {
      "privacy-core": {
        hooks: { allowConversationAccess: true },
        config: {
          mode: "private",
          residency: "eu",
          egress: {
            allow: ["gmail.googleapis.com", "www.googleapis.com", "oauth2.googleapis.com"],
          },
          boundary: { mode: "summary_only", maxChars: 4000 },
        },
      },
      privatemode: { config: { attestation: { maxAgeMinutes: 15, manifestPin: "strict" } } },
    },
  },
}
```

Everything else (proxy, browser, agents, A2A) is identical to the non-EU private gateway.

`manifestPin: "strict"` is the right setting for a fixed customer deployment: a rotated vendor manifest stops requests instead of being accepted silently. Re-pin deliberately after reviewing the change.

## Main gateway differences

```json5
{
  agents: {
    entries: {
      chief: { model: "mistral/mistral-large-latest" },
      research: { model: "mistral/mistral-large-latest" },
      builder: { model: "mistral/codestral-latest" },
    },
  },
  models: {
    providers: {
      mistral: { apiKey: { source: "store", provider: "default", id: "MISTRAL_API_KEY" } },
    },
  },
  plugins: {
    allow: ["mistral", "telegram", "a2a", "privacy-core", "browser", "memory-core"],
    entries: {
      "privacy-core": {
        // The run gate needs conversation access to refuse non-EU runs.
        hooks: { allowConversationAccess: true },
        config: {
          mode: "standard",
          residency: "eu",
          // Your assertion, not the vendor's: confirm with their contract first.
          providers: { mistral: { region: "eu" } },
        },
      },
    },
  },
}
```

Without the `providers.mistral` line the main gateway refuses every run, and `openclaw privacy status` says:

```
REFUSING AGENT RUNS: 3 problems in the privacy config:
  - agents.entries.chief.model: provider "mistral" is not EU-resident (no region is declared for it) but residency is "eu"; confirm the processing region with the vendor, then set plugins.entries.privacy-core.config.providers.mistral.region = "eu"
  - agents.entries.research.model: ...
  - agents.entries.builder.model: ...
```

Data-residency facts that must be confirmed with each vendor before this configuration is sold: where Privatemode's enclaves run, the transfer basis, and the processing region of the standard provider. See the placeholders in [PRIVACY](PRIVACY.md).
