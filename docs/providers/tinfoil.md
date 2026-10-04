# Tinfoil

Tinfoil runs open models inside hardware-attested enclaves (AMD SEV-SNP). The `tinfoil` plugin is the default provider for private gateways.

## How requests flow

```
OpenClaw model transport ──http──▶ tinfoil relay (127.0.0.1:19931) ──attested, encrypted──▶ Tinfoil enclave
```

The relay is part of the plugin. It accepts only `/v1/` requests on loopback and forwards them only through the Tinfoil SDK's `SecureClient`.

What the plugin enforces, in code:

- Before the first request, and again after `attestation.maxAgeMinutes` (default 15), the SDK verifies the enclave's hardware attestation, the Sigstore-signed release of the router code (`tinfoilsh/confidential-model-router`), the measurement equality, and the enclave's key binding. If any step fails, the relay answers with an error and **no request is sent**.
- Request bodies are HPKE-encrypted to the verified enclave; the SDK refuses any other origin.
- Every verification outcome (pass or fail, measurement fingerprint, release digest, verifier version, time) is written to `<stateDir>/logs/privacy-audit.jsonl`.
- The prompt-cache scoping secret is generated per gateway under `<stateDir>/tinfoil/user-cache-secret` (mode `0600`), so gateways never share a cache namespace.

## Setup

```bash
openclaw --profile private plugins install -l --accept-capabilities ~/openclaw-private/plugins/tinfoil
openclaw --profile private secrets store set TINFOIL_API_KEY
```

Then in the private gateway's `openclaw.json` (stock OpenClaw requires the full block for a plugin provider):

```json5
{
  agents: { defaults: { model: "tinfoil/gpt-oss-120b" } },
  models: {
    providers: {
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
  plugins: { entries: { tinfoil: { config: { attestation: { maxAgeMinutes: 15 } } } } },
}
```

`deepseek-v4-flash` is also available; add it to `models` the same way. To move the relay, set `plugins.entries.tinfoil.config.relay.port` and the matching `baseUrl`.

## Network

Hosts contacted: `atc.tinfoil.sh` (attestation bundle and router list) and the attested router under `*.tinfoil.sh`. On a private gateway, privacy-core adds both to the egress allowlist automatically. No Sigstore, GitHub or AMD host is contacted at runtime; the trust roots are embedded in the verifier.

## Honest limits

Attestation proves that the published open-source build is what runs on genuine AMD hardware. It does not remove the need to trust AMD's root of trust, nor prove anything about code that is not part of the published build. See [PRIVACY](../PRIVACY.md) for the full data-flow table.
