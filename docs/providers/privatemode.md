# Privatemode

Privatemode is operated by Edgeless Systems GmbH (Germany). It runs open models inside attested confidential-compute enclaves (AMD SEV-SNP and Intel TDX, orchestrated by Edgeless Contrast). The `privatemode` plugin is the provider for EU-only private gateways (`residency: "eu"`).

## How requests flow

```
OpenClaw model transport ──http──▶ privatemode relay (127.0.0.1:19932) ──attested, encrypted──▶ Privatemode enclave
```

The relay is part of the plugin. It accepts only `/v1/` requests on loopback and forwards them only through the `privatemode-ai` SDK.

What the plugin enforces, in code:

- Before the first request, and again after `attestation.maxAgeMinutes` (default 15), the SDK fetches the deployment's attestation, verifies it against a manifest of reference values, and establishes an encryption secret with the enclave. If verification fails, the relay answers with an error and **no request is sent**.
- The verifier is a WASM module shipped with the SDK; the plugin pins its SHA-256 and refuses a module that does not match.
- The manifest is fetched from Edgeless's CDN on first use and pinned under `<stateDir>/privatemode/manifest.json` (mode `0600`). With `attestation.manifestPin: "strict"` a rotated manifest is refused; with `"auto"` (default) it is accepted and recorded in the audit log as `manifestRotated`.
- Every verification outcome (pass or fail, trusted measurement, SDK version, time) is written to `<stateDir>/logs/privacy-audit.jsonl`.
- Each request is authenticated with the API key OpenClaw sends with it, taken from your SecretRef. The plugin never reads a key from the environment, so the relay cannot lend your key to a caller that did not present it.

## Setup

```bash
openclaw --profile private plugins install -l --accept-capabilities ~/openclaw-private/plugins/privatemode
openclaw --profile private secrets store set PRIVATEMODE_API_KEY
```

Then in the private gateway's `openclaw.json`:

```json5
{
  agents: { defaults: { model: "privatemode/gpt-oss-120b" } },
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
    entries: {
      privatemode: { config: { attestation: { maxAgeMinutes: 15, manifestPin: "auto" } } },
    },
  },
}
```

## Network

Hosts contacted: `api.privatemode.ai` (attestation, secret exchange, inference) and `cdn.confidential.cloud` (manifest). On a private gateway, privacy-core adds both to the egress allowlist automatically. Whether the verifier also contacts `kdsintf.amd.com` for AMD certificates is not yet confirmed; if attestation fails with a refusal for that host in `openclaw privacy status`, add it to `egress.allow`.

## Honest limits

The trust anchor is a manifest published by the vendor, not a public transparency log. Pin it strictly for a fixed deployment, or accept vendor rotation and audit it. Where the enclaves physically run and the contractual transfer basis are items to confirm with the vendor; see [PRIVACY](../PRIVACY.md).
