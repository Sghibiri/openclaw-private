# OpenClaw Private: plan and history

## v3.1 (2026-10-03): skill approval

A skill is instructions an agent follows on every run. Without approval, a prompt injection in one email could become a standing instruction: the agent writes a skill (Skill Workshop applies its own proposals by default) or edits one in a writable workspace.

| Decision                                                                                                                                              | Why                                                                                                                                                                                                                                          |
| ----------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Approve by fingerprint (SHA-256 over every file's path, content and executable bit), checked in `before_agent_run`                                    | Names alone let changed content through. The run gate is the one place every run passes                                                                                                                                                      |
| Require approval for every skill folder in every non-shipped root, whatever its name or the agent's list says; the fingerprint covers the folder name | A first version copied OpenClaw's naming and visibility rules; review found five ways they differed (YAML names, symlinked folders, nesting depth, case-insensitive SKILL.md on macOS, skill keys). Not copying them removes the whole class |
| Trust skills shipped with OpenClaw and installed plugins                                                                                              | They are part of code the owner already runs; fingerprinting them would demand re-approval on every update                                                                                                                                   |
| Approvals stored in privacy-core's config, written with OpenClaw's config writer                                                                      | Owner-controlled, visible, picked up by a running gateway without restart                                                                                                                                                                    |
| Private mode: sandbox `workspaceAccess` not `rw`, Workshop `off`/`propose` with `approvalPolicy: "pending"`                                           | Stops the agent writing skills or its own instructions; otherwise its next run would be refused                                                                                                                                              |
| No install-time block (`before_install`)                                                                                                              | A new skill stays unusable until approved anyway, and private egress already blocks ClawHub                                                                                                                                                  |

Proven on stock 2026.9.6 (standard gateway, approval on): run refused for a new skill, allowed after `privacy skills approve` without a restart, refused again after a one-line edit, refused for a Workshop copy shadowing the approved name. In private mode OpenClaw prepares the sandbox before `before_agent_run`, so this environment (no Docker) stops earlier; the gate code path is the same.

## v3 (2026-10-03): a plugin pack on stock OpenClaw

The fork imported OpenClaw as a snapshot and patched 16 core files. Fourteen days later upstream was 7.906 commits ahead, with 30 security-related commits, and 13 of the 16 patched files had changed upstream, so every rebase would conflict. v3 drops the fork. The same rules now run as three plugins on unmodified OpenClaw, installed with the official installer and updated with `openclaw update`.

Each core patch, and what replaced it:

| Fork patch                          | Stock OpenClaw replacement                                                            | Proven on 2026.9.6                                                                                           |
| ----------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Provider-owned model fetch hook     | A loopback relay inside the provider plugin, forwarding only through the attested SDK | Agent run through the relay. Attestation failed (host blocked in the build environment) and nothing was sent |
| Boot validation in gateway startup  | Run gate on `before_agent_run`, plus a per-run model check                            | Unsafe config: run refused, `privacy status` names the key                                                   |
| Egress allowlist in the fetch guard | Upstream `proxy.proxyUrl`, pointed at an allowlisting proxy served by privacy-core    | `fetch` and `node:https` allowed and denied. With the plugin gone, all egress failed                         |
| `privacy` config block              | `plugins.entries.privacy-core.config`                                                 | Config schema in the manifest                                                                                |
| Manifest `providerPrivacy` field    | Trust table in privacy-core, relay URL checked in config                              | Unit tests                                                                                                   |
| SDK entry `attested-provider`       | `shared/` code inside the pack                                                        | Unit tests                                                                                                   |
| Memory commands in memory-core      | `openclaw privacy memory` in privacy-core                                             | Unit tests                                                                                                   |

What got weaker, and what got stronger:

- Weaker: an unsafe private config no longer stops the gateway from starting. It stops every agent run instead.
- Weaker: if privacy-core fails to load, its gate, policy and door filter are gone too. The egress proxy is also gone, so nothing outside the machine is reachable. A local Ollama agent could still answer unfiltered.
- Stronger: egress control now covers every client in the process, including `node:http`, WebSockets and child-process proxy variables, instead of only the shared fetch guard.
- Stronger: the gate checks the model of each actual run, not only the config.
- Stronger: OpenClaw updates and security fixes arrive the day they ship.

### Independent review of v3 (2026-10-03)

A separate review of the relay, proxy, gate and validator found three high, five medium and seven low issues. All are fixed with tests:

| Finding                                                                           | Fix                                                                                                                                                                                                                                                                                                    |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Sandbox containers and the sandboxed browser reach the internet without the proxy | Private mode requires container network `none` and refuses the sandboxed browser                                                                                                                                                                                                                       |
| Ollama cloud models pass as local                                                 | Refused in config and at run time                                                                                                                                                                                                                                                                      |
| The run gate is not delivered without conversation access                         | Relays, proxy and action policy refuse everything on their own while the config is unsafe                                                                                                                                                                                                              |
| Plain-HTTP forwarding loops through the host's proxy routing                      | The proxy only opens HTTPS tunnels to port 443                                                                                                                                                                                                                                                         |
| Port squatting on the relay or proxy port                                         | A service registry; runs are refused until each needed service holds its port                                                                                                                                                                                                                          |
| Operator `local` region passes for hosted providers                               | Local requires an explicit loopback URL, except Ollama's default                                                                                                                                                                                                                                       |
| Privatemode key handling; relays accept any Host                                  | Each request authenticates with its own key; relays refuse foreign Host and any Origin                                                                                                                                                                                                                 |
| `relay.port` could not work                                                       | Validation follows each provider plugin's relay port                                                                                                                                                                                                                                                   |
| Smaller gaps                                                                      | Missing provider id refused, residency checked at run time on standard gateways, every model slot scanned, invalid allowlist patterns filtered, `Expect` dropped, proper 413, dot segments refused, Privatemode clients retired after a grace period, proxy refuses private addresses and has timeouts |

Not done: per-boot credentials on the proxy URL. The service registry covers the start-up race; a squatter that starts before the gateway is also caught, because the gateway's own proxy then fails to bind and runs are refused.

Sections below are the v2 plan and its status log, kept as history. File paths in them refer to the retired fork layout.

---

# OpenClaw Private: plan (v2, two-house design)

Status: **plan only, no code written.** This version replaces the first draft after the design discussion of 2026-09-19. The change: the unit of isolation is a **gateway process**, not an agent inside a shared process. Section 9 records what changed and why.

Sources studied (cloned 2026-09-19):

| Source                 | Commit / version              | License                         | Role                       |
| ---------------------- | ----------------------------- | ------------------------------- | -------------------------- |
| `openclaw/openclaw`    | `cc9f100`, version 2026.9.5   | MIT                             | Base                       |
| `KenKaiii/blobbies`    | version 0.8.0                 | AGPL-3.0                        | Ideas only, no code        |
| `CopilotKit/OpenBot`   | `61cc46a`, version 0.0.13     | MIT, (c) 2026 CopilotKit        | Code to port (reduced set) |
| `tinfoilsh/tinfoil-js` | npm `tinfoil` 1.2.1           | Apache-2.0                      | SDK dependency             |
| `privatemode-ai` (npm) | 1.56.0, Edgeless Systems GmbH | MIT                             | SDK dependency             |
| `openclaw/gogcli`      | HEAD, Go 1.26                 | MIT, (c) 2026 Peter Steinberger | External binary            |

`docs.tinfoil.sh` and `docs.privatemode.ai` were unreachable from this environment (egress proxy). Tinfoil facts come from the SDK source, Privatemode facts from the published npm package. Anything that rests on less than that is marked unverified.

---

## 1. The design in one page

Two OpenClaw gateways on the same machine, one visible and one hidden.

```
 You (Telegram, mobile app, Control UI)
        |
        v
 +---------------------------+        A2A over 127.0.0.1, bearer token,
 |  MAIN gateway  (standard) |  --->  text tasks only, 64 KiB cap
 |  chief, research, builder |  <---  text answers only
 |  Telegram bot, dashboard  |        +-----------------------------+
 |  any provider             |        |  PRIVATE gateway (headless) |
 +---------------------------+        |  inbox, browser             |
                                      |  no bot, no public port     |
                                      |  Tinfoil | Privatemode | Ollama only |
                                      |  egress allowlist, sandbox always on |
                                      +-----------------------------+
```

- **Main gateway**: stock OpenClaw plus our plugins. Owns the one Telegram bot, the Control UI, mobile pairing. Runs the standard agents. Sees only what the private gateway chooses to answer.
- **Private gateway**: a second OpenClaw profile (`openclaw --profile private`, its own state dir, port, service), started in `privacy.mode: "private"`. In that mode the whole config is validated as private at boot: every agent must use an attested or loopback provider, sandbox is forced on, skills and plugins are restricted, egress is allowlisted, credentials must come from the keychain provider. It binds to loopback only and exposes its agents through upstream's **A2A channel** (`extensions/a2a`), which requires a bearer token per peer, isolates every peer into its own session, rejects slash commands, and caps text at 64 KiB.
- **The door**: the main gateway's chief calls a new tool `ask_private_agent(agent, question)`. The tool sends a blocking A2A `SendMessage` to the private gateway and returns the reply artifact text. Upstream's own outbound A2A is fire-and-forget, so this tool is new, but it is a plugin. On the private side, an **edge filter** owned by our plugin runs on every A2A reply: it returns only the agent's final text, strips fenced blocks, quoted email bodies and anything that looks like a tool result, enforces a length cap, and writes an audit row `{from, to, bytes, timestamp}`. Raw tool output, attachments and page dumps never exist in the main gateway process.
- **Direction rule**: main → private carries instructions. Private → main carries one text field. Private → anywhere else carries nothing, because the private gateway has no channels and its egress allowlist has no other destinations.

What you see: one bot, one dashboard. What you run: two services (`openclaw gateway install` twice, second with `--profile private --port 19789`, as `docs/gateway/multiple-gateways.md` describes for a rescue bot).

Honest limits, to be stated in `docs/PRIVACY.md`:

1. The text the private agent answers with is model output. The edge filter stops bulk and accidental leakage; it cannot stop a private model that was tricked by an email into repeating a secret in its answer.
2. The private gateway's host sees plaintext (SQLite, workspace). On your own machine that is you. On a rented server it is the host.
3. Channels are transit. Telegram sees what you and the agent say to each other.

---

## 2. What was found in each source (unchanged facts, condensed)

### 2.1 OpenClaw

Already present upstream and reused as is:

| Need                                    | Upstream owner                                                                                                                                                                                                                                   | Notes                                                                                                                                                       |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Per-agent config, bindings, group chats | `agents.entries.<id>`, `bindings[]`, `broadcast` (`src/config/zod-schema.agents.ts`, `zod-schema.agent-runtime.ts`)                                                                                                                              | Boot fails on invalid config in `assertValidGatewayStartupConfigSnapshot()` (`src/gateway/server-startup-config-helpers.ts:54`)                             |
| Provider plugins                        | `extensions/<id>/`, `defineSingleProviderPluginEntry()` (`src/plugin-sdk/provider-entry.ts`), `createStreamFn` hook (`src/plugins/provider-transport.types.ts`)                                                                                  | A plugin can own its transport entirely; used by `extensions/ollama`, `apple-fm`, `radius`. Template: `extensions/venice`                                   |
| Gateway-to-gateway messaging            | `extensions/a2a` (`src/http.ts`, `inbound.ts`, `outbound.ts`)                                                                                                                                                                                    | Inbound: bearer token per peer, isolated session per peer and context, text only, 1 MiB request cap, 64 KiB text cap, 30 req/min. Outbound: fire-and-forget |
| Multiple gateways per host              | `docs/gateway/multiple-gateways.md`, `--profile`, `gateway.bind: "loopback"` (default)                                                                                                                                                           | Base ports at least 120 apart                                                                                                                               |
| Outbound network choke point            | `fetchWithSsrFGuard()` (`src/infra/net/fetch-guard.ts:416`), `SsrFPolicy.allowedHostnames` (`src/infra/net/ssrf.ts`)                                                                                                                             | 9 call sites cover LLM, web tools, MCP, skills install, previews                                                                                            |
| Secrets                                 | SecretRefs (`src/secrets/ref-contract.ts`), shared secret store (SQLite, unencrypted at rest), secret egress proxy with host allowlist (`src/secrets/egress-proxy/`)                                                                             | **No OS keychain backend.** 1Password and Vault plugins show the exec-provider pattern                                                                      |
| Sandbox                                 | `AgentSandboxSchema` (`zod-schema.agent-runtime.ts:592`), `resolveSandboxConfigForAgent()` (`src/agents/sandbox/config.ts:222`), docker defaults `network: "none"`, `readOnlyRoot`, `capDrop ALL`, sandboxed Chromium container with `noVncPort` | **No gVisor.** No "cannot be disabled" flag                                                                                                                 |
| Approvals                               | exec approvals in state SQLite, Telegram inline buttons (`extensions/telegram/src/approval-terminal.ts`), plugin SDK `src/plugin-sdk/approval-*.ts`                                                                                              | Reused for take-the-wheel delivery                                                                                                                          |
| Audit                                   | metadata-only ledger in state SQLite, 30-day retention (`src/audit/audit-event-store.ts`), default on                                                                                                                                            | New event types added under this owner                                                                                                                      |
| Memory                                  | per-agent `MEMORY.md` plus `<agentDir>/openclaw-agent.sqlite`; `extensions/memory-core` CLI `status                                                                                                                                              | index                                                                                                                                                       | search | forget | promote` | No shared facts store, no `list | show | edit | delete` |
| Web search                              | plugins `duckduckgo` (scrapes `html.duckduckgo.com`), `brave`, `searxng`, others                                                                                                                                                                 | No Bing, no DDG Lite                                                                                                                                        |
| Browser                                 | `extensions/browser`, managed Chromium profile `openclaw`; `browser.allowSystemProfileImport` default true (imports the user's Chrome cookies on macOS)                                                                                          | Must be off in the private gateway                                                                                                                          |
| Skills                                  | per-agent allowlist `agents.entries.<id>.skills: string[]` (`src/skills/discovery/agent-filter.ts`); ClawHub installs gated by `security.installPolicy`                                                                                          |                                                                                                                                                             |

Upstream churn measured on `main`: 2.901 commits between 2026-09-14 and 2026-09-19 (about 480 per day); `src/gateway` alone 571. The files this plan patches changed 1 to 3 times in that window each. `src/agents/subagents/announce` changed 25 times and is no longer touched by this plan.

### 2.2 Blobbies (ideas)

Privacy table style for `docs/PRIVACY.md`; allowlisted argv-only command runner with per-program flag allowlists; loopback-only Ollama; keychain with a default-deny name list; memory table where every entry is editable and deletable; untrusted-content fencing with random marker ids. Its search order is Bing first, then DuckDuckGo Lite (DDG Lite served CAPTCHAs, per a code comment dated 2026-08-15). It keeps **no attestation log**. Nothing is copied.

### 2.3 OpenBot (code)

The gateway, CEL policy, audit and control code import nothing from CopilotKit. What is ported, re-targeted to SQLite via Kysely:

| Piece                          | Source file                                                       | Kept behaviour                                                                                                                                                                        |
| ------------------------------ | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Decide, record, act            | `server/src/computer/gateway.ts` `govern()` (lines 427-620)       | Audit row written at line 533, before the refusal throw (545) and before the action (584); second row on failure                                                                      |
| CEL policy                     | `server/src/computer/policy.ts` (387 lines), `cel-js@0.8.2`       | Deny before allow; absent policy permits nothing; throwing or non-boolean deny counts as a match; every variable always bound, neutral-empty when absent; custom `contains`/`matches` |
| Control state machine          | `agent-computer/src/control.ts` (312 lines, no Playwright import) | Bot cannot hand itself over; agent actions while a human holds the wheel are refused, not queued; help requests expire after 10 min, a person holding the wheel never does            |
| Secret typing                  | `agent-computer/src/index.ts:708-759`, `gateway.ts:782-791`       | Value typed into a named ref, never stored; audit row records `"<n> characters"`; the form is not submitted by the same action                                                        |
| Audit vocabulary and redaction | `server/src/audit.ts:17-47, 540-555`                              | Closed event list, key-name redaction on every write                                                                                                                                  |

Not ported: `supervisor/` (dockerode container manager, replaced by upstream's docker sandbox backend plus two small additions), `agent-computer/` (Playwright container, replaced by upstream's sandboxed Chromium), `screencast.ts` (replaced by upstream noVNC), Postgres, Hono routes, SSO, web UI.

### 2.4 Tinfoil (`tinfoil` 1.2.1)

- `SecureClient` attests **once per client instance**, lazily, memoized; re-attests on `reset()`, HPKE key mismatch, pinned-TLS failure. `SecureClient.fetch` awaits attestation and refuses any origin other than the attested enclave. No skip option. `tinfoil/unsafe` exists and will be forbidden by lint.
- Verifies AMD SEV-SNP report and VCEK chain, a Sigstore DSSE bundle for repo `tinfoilsh/confidential-model-router` on a tag ref, measurement equality, TLS cert and HPKE key binding. Sigstore trusted root is **embedded**; the verifier package has one `fetch()` call site. **No Sigstore network traffic at runtime.**
- Encrypted bodies (HPKE, `ehbp`) on by default. Headers and URL travel in TLS only.
- Hosts: `atc.tinfoil.sh` (attestation bundle, router list) and the enclave host it names (observed `inference.tinfoil.sh`; dynamic, so `*.tinfoil.sh`).
- Audit material: `VerificationDocument { codeFingerprint, enclaveFingerprint, releaseDigest, releaseTag, enclaveHost, verifier.version, verifiedAt, securityVerified, steps }`.
- Prompt-cache scoping: `user_cache_secret`, default persisted at `~/.tinfoil/user_cache_secret`; we set it per agent.
- Models: `client.models.list()` against the enclave. Catalog page unreachable; ids discovered live.

### 2.5 Privatemode (`privatemode-ai` 1.56.0)

- MIT, in-process SDK, OpenAI-compatible surface (chat, embeddings, transcriptions, models). `verify()` fetches and verifies the coordinator attestation lazily before the first request; unsupported OpenAI resources fail closed.
- Verifier is a 27.7 MB Go WASM module built from Edgeless Contrast v1.24.0 (SEV-SNP and TDX validators). `expectedWasmHash` pins it.
- Trust anchor is a manifest fetched from `https://cdn.confidential.cloud/privatemode/v2`; `manifestBytes` pins it locally; `onManifestUpdate` reports rotation. API host `https://api.privatemode.ai`. The WASM also references `kdsintf.amd.com`; whether it is contacted directly is settled by a network trace in Phase 1b.
- Attestation result: `VerifyResult { manifest }` with `ReferenceValues.snp[].TrustedMeasurement`, `MinimumTCB`, `AllowedChipIDs`. No timestamp; we stamp it.
- **Unverified**: enclave location and provider, transfer basis, re-attestation schedule. Placeholders in `docs/PRIVACY.md`.

### 2.6 gogcli (`gog`)

Go CLI, MIT. Tokens in the OS keyring (`99designs/keyring`; on headless Linux without D-Bus it forces an encrypted file backend with `GOG_KEYRING_PASSWORD`). Customer-owned OAuth client via `gog auth credentials set`. Runtime flags `--readonly` (HTTP round-tripper blocks non-GET except a hardcoded read-shaped POST list), `--gmail-no-send`, `--wrap-untrusted`, `--enable-commands-exact`, `--no-input`, `--sanitize-content`. **Baked safety profiles** (`./build-safe.sh safety-profiles/<x>.yaml`, build tag `safety_profile`, rules as FNV-64a hash switches, `locked-flags`) survive a model-written argv; runtime flags do not. `gog schema --json` reports the effective safety state. Read-only allowlist (canonical dotted paths): `gmail.search`, `gmail.get`, `gmail.thread.get`, `gmail.labels.list`, `gmail.drafts.list`, `calendar.calendars`, `calendar.events`, `calendar.event`, `calendar.freebusy`, `calendar.search`, `calendar.conflicts`. Block: `gmail.send`, `send`, `gmail.reply`, `gmail.reply-all`, `gmail.forward`, `gmail.autoreply`, `gmail.drafts.send`, `gmail.import` (the last is not covered by `--gmail-no-send`).

---

## 3. Config

One file per deployment still describes the whole roster. The private gateway reads the same file with `--profile private` and its `privacy.mode`.

```json5
// Main gateway (default profile)
{
  privacy: {
    mode: "standard",
    residency: "any",                         // "eu" switches EU defaults for every agent
    peers: { private: { url: "http://127.0.0.1:19789/a2a/v1" } }   // where ask_private_agent sends
  },
  agents: { entries: { chief: {...}, research: {...}, builder: {...} } },
  channels: {
    telegram: {...},
    a2a: { enabled: true, peers: { private: { token: { source: "keychain", provider: "os", id: "a2a-private-inbound" },
                                             url: "http://127.0.0.1:19789/a2a/v1",
                                             outboundToken: { source: "keychain", provider: "os", id: "a2a-private-outbound" } } } }
  }
}

// Private gateway (profile "private", port 19789)
{
  privacy: {
    mode: "private",
    residency: "any",                         // "eu" forbids tinfoil, defaults to privatemode
    egress: { allow: ["gmail.googleapis.com", "www.googleapis.com"] },   // deployment-wide extra hosts
    boundary: { mode: "summary_only", maxChars: 4000 },
    policy: { deny: [...], allow: ["true"] }  // CEL, see 4.4
  },
  gateway: { bind: "loopback", port: 19789 },
  agents: {
    entries: {
      inbox:   { model: "tinfoil/<model>", skills: ["gog-workspace"], sandbox: { mode: "all" } },
      browser: { model: "tinfoil/<model>", sandbox: { mode: "all", browser: { enabled: true } } }
    }
  },
  bindings: [
    { agentId: "inbox",   match: { channel: "a2a", peer: { kind: "direct", id: "main-inbox" } } },
    { agentId: "browser", match: { channel: "a2a", peer: { kind: "direct", id: "main-browser" } } }
  ],
  channels: { a2a: { enabled: true, exposeAgents: ["inbox", "browser"],
                     peers: { "main-inbox": { token: {keychain ref} }, "main-browser": { token: {keychain ref} } } } },
  plugins: { allow: ["tinfoil", "privatemode", "ollama", "a2a", "memory-core", "gog-workspace", "privacy-core", "browser", "duckduckgo"] }
}
```

Resolution rules, enforced at boot of the **private** gateway (`privacy.mode: "private"`):

| Rule             | Check                                                                                                                                                                                                                                                                                                                                |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Providers        | Every model ref (primary, fallbacks, utilityModel, imageModel) must resolve to a provider plugin whose manifest declares `privacy.attested: true`, or `privacy.region: "local"` with a loopback base URL. `residency: "eu"` additionally requires `region !== "us"`. Missing `privacy` block means `{attested: false, region: "us"}` |
| Default provider | `model` omitted: `tinfoil/<default>` for `any`, `privatemode/<default>` for `eu`                                                                                                                                                                                                                                                     |
| Sandbox          | `sandbox.mode` is forced to `"all"`; a config that says otherwise is an error, not a warning. `backend` in `docker                                                                                                                                                                                                                   | podman`. `browser.allowHostControl` must be false |
| Plugins          | `plugins.allow` is required and may contain only the list above plus other provider plugins that pass the provider rule; `cua-computer`, `bonjour`, `composio` (reserved id), any channel plugin except `a2a` are refused                                                                                                            |
| Skills           | `agents.entries.<id>.skills` must be explicit; every entry must be bundled or listed in `privacy.skills.allow`                                                                                                                                                                                                                       |
| Egress           | `privacy.egress.allow` entries are exact lowercase hostnames; the baseline is derived from the configured providers (section 4.3)                                                                                                                                                                                                    |
| Credentials      | Every provider `apiKey`, A2A token and OAuth secret must be a SecretRef with `source: "keychain"`; literals, `${ENV}` templates and `file` refs are refused                                                                                                                                                                          |
| Channels         | Only `a2a` may be enabled                                                                                                                                                                                                                                                                                                            |
| Memory           | `plugins.slots.memory` must be `memory-core`; shared-facts writes disabled                                                                                                                                                                                                                                                           |
| Defaults flipped | `models.catalogRefresh.enabled=false`, `update.checkOnStart=false`, `telemetry` off, `discovery` off, `browser.allowSystemProfileImport=false`, `browser.evaluateEnabled=false`, `logging.audit.messages="off"`                                                                                                                      |

Standard gateway with `residency: "eu"`: every model ref must resolve to `region: "eu"` or `"local"`. Which upstream providers get `region: "eu"` in their manifest is open question 5.

---

## 4. Components

### 4.1 Attested providers (Phase 1, 1b)

Shared SDK contract `src/plugin-sdk/attested-provider.ts`:

```ts
type AttestationRecord = {
  provider;
  agentId;
  ok;
  at;
  measurement?;
  releaseDigest?;
  enclaveHost?;
  verifierVersion?;
  error?;
};
interface AttestedTransport {
  ensureAttested(): Promise<AttestationRecord>;
  streamFn: StreamFn;
  listModels(): Promise<string[]>;
}
```

`extensions/tinfoil` and `extensions/privatemode` implement it through the `createStreamFn` hook, so every request goes through the SDK's own attested client. One client per (provider, agent) is kept; it is re-attested at each run start and at most every 15 minutes (`SecureClient.reset()`, `PrivatemodeAI.verify()`), and every attestation writes an audit row `privacy.attestation` plus a line in the JSONL mirror. If attestation throws, the run fails with the error text; no request is built. Manifest declares `privacy: { attested: true, region: "us" }` for Tinfoil and `{ attested: true, region: "eu" }` for Privatemode (region claim to be confirmed, section 8). Privatemode pins `manifestBytes` and `expectedWasmHash` from files under the profile's state dir, updated by an explicit CLI command, never silently.

### 4.2 Privacy core plugin (Phase 1)

`extensions/privacy-core`: the boot validator (section 3), the audit event types, the JSONL mirror, the `ask_private_agent` tool (main side), the A2A reply edge filter (private side, registered as a channel outbound hook on the `a2a` channel), and the CLI `openclaw privacy status|attestations|crossings`.

### 4.3 Egress guard (Phase 2)

Two layers in the private gateway, both gateway-wide, no per-agent bookkeeping:

1. **In-process**: `fetchWithSsrFGuard()` gains an optional gateway-wide allowlist consulted when `privacy.mode === "private"`: baseline hosts derived from configured providers (`atc.tinfoil.sh`, `*.tinfoil.sh`; `api.privatemode.ai`, `cdn.confidential.cloud`; `127.0.0.1:11434`, `localhost:11434`) plus `privacy.egress.allow`. Anything else throws `EgressBlockedError` and writes `privacy.egress_blocked {host}`. This is the one core patch in this phase (about 20 lines).
2. **Spawned tools and containers**: upstream's secret egress proxy is auto-enabled with `allowedHosts` set to the same list. Sandbox containers for private agents get `network: "proxy-only"`: an `internal: true` Docker bridge with no default route plus the gateway proxy attached to it; the container's `HTTP(S)_PROXY` and Chromium `--proxy-server` point at the proxy. A socket that ignores the proxy has no route. This is the mechanism behind test 9.

Web search for private agents: upstream `duckduckgo` plugin (host `html.duckduckgo.com`), only if that host is in `privacy.egress.allow`. Bing HTML fallback is not built unless asked (open question 6).

### 4.4 Action gateway, policy, take the wheel (Phase 2b)

- `src/privacy/action-gateway.ts` (ported `govern()`), registered as a stage in `src/agents/agent-tools.before-tool-call.policy.ts` for `browser`, `exec`, `write`, `edit`, `apply_patch`, `process`, MCP tools. Sequence: build `PolicyContext` (`tool.name`, `intent`, `agent.id`, `page.host`, `file.*`, `command`, `mcp.*`, `approval.granted`), evaluate, write the audit row, then act or throw `ActionRefusedError` naming the rule.
- `src/privacy/policy.ts` (ported CEL engine), policy from `privacy.policy` in config, mirrored to a Kysely table for dry-run replay. Private default: `deny: ["intent in ['activate','type','navigate','write_file','run_command','write_tool'] && !approval.granted"], allow: ["true"]`. Standard default: OpenBot's `{deny: [], allow: ["true"]}`.
- `src/privacy/control.ts` (ported state machine). Triggers: a refused write, or a page whose accessibility snapshot shows password, one-time-code or card fields. `requestHelp` is delivered through upstream's approval delivery runtime, which the **main** gateway renders as a Telegram message with the noVNC link of the private gateway's browser container and as a Control UI approval. While a person holds the wheel, agent actions are refused.
- `secret_fill(ref)`: person supplies the value through the masked `secrets` prompt, it is typed into the ref, never stored, audited as `"<n> characters"`.
- Sandbox additions (core, small): `sandbox.docker.runtime: "runc" | "runsc"` mapped to `HostConfig.Runtime` with a boot probe; a per-container token in the container env, checked by the exec bridge; `network: "proxy-only"`.
- `extensions/gog-workspace`: runs a baked `gog-readonly` binary with the exact-command allowlist and locked flags; refuses to start if `gog schema --json` does not report the baked profile. A `gog-send` profile is reachable only through the action gateway with manual approval.

### 4.5 The door (Phase 3, replaces the in-process redaction boundary)

- Main side: `ask_private_agent({ agent: "inbox" | "browser", question })` sends a blocking A2A `SendMessage` to the private gateway with the peer credentials for that agent and returns the artifact text. It is the only way a standard agent reaches a private one. `sessions_send`, subagents and group threads never see private agents because they are not in the main process.
- Private side: the edge filter on every A2A reply. `summary_only`: keep the agent's final text, drop fenced code blocks, lines starting with `>`, anything between untrusted-content markers, base64 runs, and cap at `maxChars`; the private agent's system prompt also instructs it to answer external callers with a summary. `block`: refuse all A2A replies (the agent can still act on instructions and report to you through the main gateway's relay). Every crossing writes `privacy.boundary_crossing {from, to, bytes, at}`.
- Direct chat with inbox through the single bot: chief relays. Whether a Telegram conversation can be bound straight to a remote A2A agent is checked in Phase 3; not promised.

### 4.6 Memory and credentials (Phase 4)

- Shared facts: table `shared_facts` in the **main** gateway's state SQLite, owned by `extensions/memory-core` (`src/shared-facts.ts`), tools `facts_list|facts_add|facts_delete`. The private gateway has read access through a read-only A2A task type (`facts.list`) and no write path at all; the `private` flag is reserved for operator-entered facts. Because processes are separate, "private agents never write to shared memory" is structural, and the test simply asserts the private gateway's state dir contains no `shared_facts` table and the main table is unchanged after a private run.
- CLI: `openclaw memory list|show|edit|delete --agent <id>` added to `extensions/memory-core/src/cli.runtime.ts`, works on either profile.
- Keychain: new SecretRef source `keychain` (`src/secrets/ref-contract.ts`, `resolve.ts`, `src/config/types.secrets.ts`) implemented in `src/secrets/keychain/` with `@napi-rs/keyring` 2.1.0 (MIT; prebuilt for macOS, Windows, Linux glibc and musl). Service `openclaw-<profile>`, account `<name>`. Headless Linux fallback is open question 2.
- Isolation test: everything the private gateway writes is under its own profile state dir; a test enumerates writes during a run.

### 4.7 Docs (Phase 5)

`docs/PRIVACY.md` (per-data-type table; per-provider table with country, enclave location, transfer basis placeholders; the three honest limits from section 1), `docs/AGENTS-EXAMPLE.md` and `docs/AGENTS-EXAMPLE-EU.md` (now each shows the two profiles), `README.md` two-tier section in plain language, `NOTICE`.

---

## 5. Files to touch

Core patches (kept small, each proposed upstream):

| File                                                                                                                        | Change                                                               | Phase |
| --------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | ----- |
| `src/config/zod-schema.root-shape.ts`                                                                                       | top-level `privacy` block                                            | 1     |
| `src/plugins/manifest-types.ts`, `manifest-registry.ts`                                                                     | provider manifest `privacy: {attested, region}`                      | 1     |
| `src/gateway/server-startup-config.ts`                                                                                      | call the privacy validator after the snapshot assert                 | 1     |
| `src/infra/net/fetch-guard.ts`                                                                                              | gateway-wide allowlist when `privacy.mode === "private"`             | 2     |
| `src/config/zod-schema.sandbox.ts`, `src/agents/sandbox/docker.ts`, `docker-backend.ts`, `browser.ts`, `browser-network.ts` | `runtime`, per-container token, `network: "proxy-only"`              | 2b    |
| `src/agents/agent-tools.before-tool-call.policy.ts`                                                                         | action gateway stage (or a plugin hook if one exists; checked in 2b) | 2b    |
| `src/secrets/ref-contract.ts`, `resolve.ts`, `src/config/types.secrets.ts`, `zod-schema.core.ts`                            | `keychain` source                                                    | 4     |
| `src/audit/audit-event-types.ts`                                                                                            | new event types                                                      | 1     |
| `package.json`, `test/vitest/vitest.privacy.config.ts`, `.oxlintrc.json`                                                    | `test:privacy`, forbid `tinfoil/unsafe`                              | 1     |

Plugins and new modules (no upstream coupling beyond the SDK):

- `extensions/tinfoil/`, `extensions/privatemode/` (Phase 1, 1b)
- `extensions/privacy-core/` (validator, audit, `ask_private_agent`, edge filter, CLI) (Phase 1, 3)
- `src/plugin-sdk/attested-provider.ts` (Phase 1)
- `src/privacy/{action-gateway,policy,policy-store,control,intent}.ts` ported from OpenBot with attribution headers (Phase 2b)
- `extensions/gog-workspace/` (Phase 2b)
- `extensions/memory-core/src/{shared-facts.ts, cli.runtime.ts}` (Phase 4)
- `src/secrets/keychain/` (Phase 4)
- `test/privacy/*.test.ts` (Phase 5), `docs/*` (Phase 5), `NOTICE` (Phase 1)

No longer touched (compared with v1): `sessions-send-helpers.ts`, `sessions-send-tool.a2a.ts`, `subagents/announce/*`, `group-thread-context.ts`, `group-thread.ts`, `src/agents/sandbox/config.ts` clamp (replaced by the whole-config validator), `zod-schema.agent-entry-base.ts` (no per-agent `privacy` field).

---

## 6. Test suite (`pnpm test:privacy`)

| #   | Test from the prompt                                    | How it is tested now                                                                                                                                                                | Docker                                                                    |
| --- | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| 1   | private + `anthropic` refuses to start                  | private-mode validator through `prepareGatewayStartupConfig`                                                                                                                        | no                                                                        |
| 2   | non-allowlisted host blocked and logged                 | `fetchWithSsrFGuard` allowlist + audit row                                                                                                                                          | no                                                                        |
| 3   | attestation mocked to fail, zero bytes sent             | `extensions/tinfoil` with `SecureClient.ready()` mocked to reject; fetch spy asserts no call                                                                                        | no                                                                        |
| 4   | marker never in a standard agent's prompt after handoff | two in-process gateway harnesses; the private one answers a task containing `SECRET_MARKER_123` in a tool result; the main model mock captures every prompt byte                    | no                                                                        |
| 5   | private memory absent from shared store                 | private gateway state dir has no `shared_facts`; main table unchanged                                                                                                               | no                                                                        |
| 6   | provider key in no file under the state dir             | keychain SecretRef; recursive scan of both profile dirs                                                                                                                             | no                                                                        |
| 7   | group chat with one private and one standard agent      | a Telegram mock where the private agent's reply is posted through the main relay; assert the standard agent's context never contains the marker (structurally true, still asserted) | no                                                                        |
| 8   | `residency: eu` + `tinfoil` refuses to start            | validator                                                                                                                                                                           | no                                                                        |
| 9   | container opens a non-allowlisted URL                   | proxy-only network; assertion on the proxy's audit row                                                                                                                              | yes, skipped visibly when Docker is absent, runs in CI on a Docker runner |
| 10  | write action without approval refused, rule named       | action gateway + private default policy                                                                                                                                             | no                                                                        |
| 11  | credential absent from transcript and audit             | `secret_fill`                                                                                                                                                                       | no                                                                        |

Added: 12, A2A reply edge filter strips fenced and quoted content and caps length; 13, a private gateway with any channel other than `a2a` refuses to start; 14, `ask_private_agent` cannot reach a peer that is not in `privacy.peers`.

---

## 7. Licensing

- OpenBot files in 4.4 keep their headers plus `Portions Copyright (c) 2026 CopilotKit (MIT)`, listed in `NOTICE`. `screencast.ts` is not ported, so its steel-browser (Apache-2.0) and DevTools (BSD-3) attributions are not needed.
- Nothing from Blobbies is copied. Every idea is re-implemented from its description; none of it needs copying.
- New dependencies: `tinfoil` (Apache-2.0), `privatemode-ai` (MIT), `cel-js` (MIT), `@napi-rs/keyring` (MIT).

---

## 8. Open questions (blocking Phase 1)

1. **Base repository.** Import upstream history into the working repository and reset this branch onto it (recommended; about 158 MB of git objects pushed once), or fork on GitHub, or squash import?
2. **Keychain on a headless server.** When no OS keychain exists: (a) refuse to start, (b) fall back to an encrypted file keyring whose passphrase comes from a systemd credential or env var, documented as such, (c) require the 1Password or Vault plugin. Recommended: (b), with (a) selectable by `privacy.credentials.keychainOnly: "strict"`.
3. **Network origins for the private baseline.** Tinfoil: `atc.tinfoil.sh`, `*.tinfoil.sh`. Privatemode: `api.privatemode.ai`, `cdn.confidential.cloud`, and `kdsintf.amd.com` only if the Phase 1b trace shows it is contacted. Sigstore CDN not added. Approve?

Decided in the discussion (recorded here so they are not re-asked): two-house design; reduced OpenBot port; audit in the SQLite ledger plus a JSONL mirror; attestation per (provider, agent) client, re-attested each run start and at most every 15 min; gVisor as opt-in with a boot probe and a warning when absent; Composio as a reserved validation rule only; `pnpm check:changed` plus `pnpm test:privacy` after each phase, full `pnpm check` before merge.

Deferred to the phase where they matter: 4, whether a Telegram conversation can be bound to a remote A2A agent (Phase 3); 5, which upstream providers may declare `region: "eu"` (Phase 1b; `mistral` is the candidate, the claim needs your confirmation); 6, Bing HTML fallback (Phase 2); 7, Tinfoil and Privatemode model ids for the example rosters (Phase 1, discovered live).

---

## 9. What changed from v1 and why

| v1                                                                                | v2                                                                                             | Reason                                                                                                                                                                     |
| --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Per-agent `tier` inside one gateway                                               | `privacy.mode` per gateway process; private agents in a headless second profile                | Isolation by process and network instead of by in-process tagging; 13 core files patched became about 7, and the three most-churned injection points are no longer touched |
| Redaction boundary patched into `sessions_send`, subagent announce, group threads | One door: `ask_private_agent` over upstream A2A plus an edge filter on the private side        | Raw data never exists in the standard process; the door is an upstream feature with token auth, session isolation and size caps already built                              |
| Egress scope tracked per request with `AsyncLocalStorage`                         | Gateway-wide allowlist, one small patch in `fetch-guard.ts`, plus proxy-only container network | Nothing to tag when the whole process is private                                                                                                                           |
| Shared facts with a per-write tier check                                          | Shared facts live only in the main gateway; private gateway has a read-only task               | Structural instead of checked                                                                                                                                              |
| 15 open questions                                                                 | 3 blocking, 4 deferred, the rest decided                                                       | Discussion of 2026-09-19                                                                                                                                                   |

Unverified items carried forward: Privatemode enclave location and transfer basis; whether the Tinfoil verifier's Sigstore library makes any network call (source says no; trace in Phase 1); whether the Privatemode WASM contacts `kdsintf.amd.com`; current model ids; whether `pnpm install` and `pnpm check` complete in this environment.

---

## 10. Status log (2026-09-19)

Delivered on `claude/openclaw-private-fork-yzbg6z`, each phase one commit, `pnpm test:privacy` green after each:

| Phase | Shipped                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Deferred (with reason)                                                                                                                                                                |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Base  | Upstream `e985a41` imported as a snapshot root; graft recipe in `docs/UPSTREAM.md`                                                                                                                                                                                                                                                                                                                                                                            | Full history (4 GB, above GitHub's push limit)                                                                                                                                        |
| 1     | Provider-owned fetch hook; manifest `providerPrivacy`; `privacy` config; private-mode validator; JSONL audit; `extensions/tinfoil`; `test:privacy` lane; unsafe-client guard; `NOTICE`                                                                                                                                                                                                                                                                        | Live Tinfoil request (API and docs unreachable from the build environment)                                                                                                            |
| 1b    | `extensions/privatemode` (SDK 1.55.0 pinned by age rule, WASM hash pinned, manifest pin auto/strict); residency default model; provider docs; `PRIVACY.md`                                                                                                                                                                                                                                                                                                    | Enclave location and transfer basis (vendor docs unreachable); `kdsintf.amd.com` trace                                                                                                |
| 2     | Process-wide egress allowlist in `fetchWithSsrFGuard` with audit rows; provider `egressHosts`; secret egress proxy auto-enabled; bundled-only plugins and skills                                                                                                                                                                                                                                                                                              | Proxy-only container network (needs Docker on the build host, planned with 2b sandbox work)                                                                                           |
| 2b    | `extensions/privacy-core`: CEL policy (deny, approve, allow), action gateway as a trusted before-tool-call policy with decide-record-act, intent mapping, control state machine, `privacy.policy` config                                                                                                                                                                                                                                                      | gVisor `runtime`, per-container token, take-the-wheel delivery to Telegram (state machine exists; the human-side take/release surface needs a gateway method), `gog-workspace` plugin |
| 3     | `ask_private_agent` tool (main) and A2A reply edge filter (private) with boundary-crossing audit rows                                                                                                                                                                                                                                                                                                                                                         | End-to-end two-gateway run (needs two live gateways); Telegram binding straight to a remote A2A agent (unverified)                                                                    |
| 4     | `openclaw memory list`, `show`, `edit`, `delete` with `--agent`                                                                                                                                                                                                                                                                                                                                                                                               | Keychain SecretRef source (`@napi-rs/keyring` 2.1.0 is under upstream's 7-day release age until 2026-09-20); shared facts store; state-dir isolation test                             |
| 5     | `docs/AGENTS-EXAMPLE.md`, `docs/AGENTS-EXAMPLE-EU.md`, README two-tier section, `PRIVACY.md` rows                                                                                                                                                                                                                                                                                                                                                             | Spec tests 5, 6, 7, 9, 11 (depend on the deferred items above)                                                                                                                        |
| 5+    | Standard-gateway EU rule with operator-declared regions (`privacy.providers.<id>.region`, manifest wins, never grants attestation); boot validation recorded in the audit log; `openclaw privacy status`; take-the-wheel human side (`privacy.control.*` gateway methods, `openclaw privacy control list`, `take`, `release`, `request_help` tool); fix: privacy-core now declares `contracts.tools`, without which the registry rejected `ask_private_agent` | The Mistral EU claim stays a placeholder until you confirm it with the vendor; Telegram delivery of help requests (the agent tells you in its reply for now)                          |

Spec test coverage so far: 1 (private + anthropic refuses), 2 (non-allowlisted host blocked and logged), 3 (failed attestation sends zero bytes), 4 (marker never crosses the door, tested at the filter and tool level), 8 (eu + tinfoil refuses), 10 (write without approval refused, rule named). Test 7 is structurally true in the two-house design and is asserted at the door filter.
