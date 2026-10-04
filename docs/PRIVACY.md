# Where your data goes

OpenClaw Private runs two stock OpenClaw gateways with this pack's plugins: a **main** gateway you talk to (standard agents, any provider) and a **private** gateway that only private agents live in (attested or local models only). The private gateway has no chat channel of its own. The main gateway reaches it through one authenticated door (A2A) and receives only a text answer.

Legal fields marked _placeholder_ are completed by the operator with each vendor.

## By data type

| Data                                                    | Where it goes                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Chats with the main gateway                             | The channel you use (Telegram, WhatsApp, Slack) and the main gateway's state directory on your machine. Channels are a transit hop and see these messages.                                                                                                                                                                                         |
| Chats with private agents                               | Only through the main gateway: the private agent's answer text crosses the door, nothing else.                                                                                                                                                                                                                                                     |
| Prompts on a standard provider (Anthropic, OpenAI, ...) | That vendor, under its terms.                                                                                                                                                                                                                                                                                                                      |
| Prompts on Ollama                                       | Nowhere. Your machine.                                                                                                                                                                                                                                                                                                                             |
| Prompts on Tinfoil                                      | Encrypted to a hardware-attested enclave; the vendor cannot read them. See [Tinfoil](providers/tinfoil.md).                                                                                                                                                                                                                                        |
| Prompts on Privatemode                                  | Encrypted to a hardware-attested enclave in the EU; the vendor cannot read them. See [Privatemode](providers/privatemode.md).                                                                                                                                                                                                                      |
| Email and calendar read by a private agent              | Google (already there), the private gateway's state directory, the enclave. Never a standard provider, never the main gateway's agents.                                                                                                                                                                                                            |
| Memories                                                | Per agent, under that agent's workspace (`MEMORY.md`, `memory/*.md`) and its SQLite. The private gateway has its own state directory; nothing in it is shared with the main gateway. See and edit them with `openclaw privacy memory`.                                                                                                             |
| Tool calls, browser actions                             | Every governed action (browser, shell, files, MCP) is evaluated by the CEL policy and recorded in the privacy audit log before it runs: tool, intent, agent, host, command text or file path, decision and rule. Typed text, file contents and results are never recorded. On a private gateway every write-shaped action waits for your approval. |
| Answers from private agents to the main gateway         | One text field per answer, after the door filter removed fenced tool output, quoted email, external-content envelopes and attachments, capped at `boundary.maxChars`. Each crossing is logged with its byte count.                                                                                                                                 |
| Anything else the private gateway sends out             | Only to allowlisted hosts, through privacy-core's egress proxy. Update checks, telemetry and hosted catalogs are refused there and logged.                                                                                                                                                                                                         |
| Attestation and privacy audit                           | `<stateDir>/logs/privacy-audit.jsonl`, metadata only, never content.                                                                                                                                                                                                                                                                               |

## By provider

| Provider    | Company, country               | Where enclaves run                 | Attestation                                                                                      | Transfer basis           |
| ----------- | ------------------------------ | ---------------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------ |
| Tinfoil     | Tinfoil, USA                   | _placeholder (US cloud regions)_   | AMD SEV-SNP, Sigstore-signed release, verified by the SDK before each connection                 | _placeholder: DPA, SCCs_ |
| Privatemode | Edgeless Systems GmbH, Germany | _placeholder: confirm with vendor_ | AMD SEV-SNP / Intel TDX via Edgeless Contrast, manifest of reference values, verified by the SDK | _placeholder: DPA_       |
| Ollama      | none, local                    | Your machine                       | n/a                                                                                              | n/a                      |

## How the rules are enforced

All of it runs as plugins on stock OpenClaw. Four mechanisms, each in code:

1. **Attested relay.** The Tinfoil and Privatemode plugins each run a relay on `127.0.0.1`. OpenClaw sends model requests to the relay; the relay sends them only through the vendor SDK, which verifies the enclave before every connection and encrypts the request to it. If verification fails, the relay answers with an error and nothing is sent. Pointing a provider anywhere else is a config problem (next point).
2. **Run gate.** privacy-core checks the config before every agent run and refuses the run while any rule is broken. It also refuses a private run whose model is not attested or local, even if a session switched models.
3. **Skill approval.** A skill is instructions, and sometimes scripts, that an agent follows. Before every run privacy-core fingerprints every skill folder the gateway would load for that agent and refuses the run if any of them is not approved as it is on disk now (`openclaw privacy skills approve`). Always on for the private gateway; opt-in for the main gateway. Private mode also requires that the sandbox mounts the agent's real workspace read-only or not at all, and that Skill Workshop changes wait for you, so an agent cannot write its own skills or instructions. This stops a trick in one email from becoming a standing instruction. Before approving, `openclaw privacy skills check` explains in plain words what a skill can do and flags dangerous patterns, with an AI review on the gateway's own model.
4. **Egress proxy.** On the private gateway, `proxy.proxyUrl` points at privacy-core's proxy, and OpenClaw routes every outbound connection of the process through it: `fetch`, `node:http`, WebSockets, and the proxy variables of child processes. Allowed: HTTPS on port 443 to the attested providers in use and to `egress.allow`, and only when the name resolves to a public address. Everything else gets 403 and an audit row. If privacy-core is not running, the proxy is missing and nothing leaves the machine.

**Lite mode** (`sandbox: "off"`, for computers without Docker) replaces the sandbox rule with a stricter tool rule: every private agent must use OpenClaw's `minimal` tool profile, deny its `gateway` tool, and may add only the memory tools. It is an allowlist: shell, files, browser, scheduled commands, MCP tools, aliases and wildcards are refused because they are not on it, and so is any tool a later OpenClaw release adds. With nothing to run, there is nothing to contain.

While the config breaks a rule, the relays, the proxy and the action policy also refuse everything on their own, so the protection does not depend on any single hook being delivered.

Skills shipped with OpenClaw or with an installed plugin are trusted as part of that code. They change when you update OpenClaw or the plugin, without a new approval.

## Checking the posture

`openclaw --profile private privacy status` prints the mode, any problems that make the gateway refuse runs, the egress allowlist, the latest attestation per provider and the recent counters (egress refusals, action outcomes, boundary crossings, handoffs). See [the CLI reference](CLI.md).

## Take the wheel

A private agent that hits a login, a captcha or a decision only you can make calls `request_help`. It cannot take or hand back control itself. You take control with `openclaw privacy control take <agent>` and hand it back with `release`; while you hold it, every non-read action of that agent is refused, not queued. Each handoff is a `control` row in the audit log.

## EU residency

`residency: "eu"` is enforced on both gateways by the run gate. Each model must resolve to a provider in region `eu` (Privatemode) or `local` on a loopback base URL (Ollama). Providers this pack does not know are refused until the operator declares one under `providers.<id>.region`. That declaration is the operator's assertion, backed by the vendor's contract; it can never mark a provider attested, so the private gateway still accepts only attested or loopback providers. See [AGENTS-EXAMPLE-EU](AGENTS-EXAMPLE-EU.md).

## Honest limits

1. The answer a private agent gives to the main gateway is model output. The door strips raw tool output, attachments and page dumps; it cannot stop a private model that was tricked by an email into repeating a secret in its answer.
2. The private gateway's host sees plaintext (its SQLite files and workspace). On your own machine that is you; on a rented server it is the host.
3. Channels are transit. Telegram, WhatsApp and Slack see what you and the agent say to each other.
4. Attestation proves that the published build runs on genuine hardware. It does not remove the need to trust the hardware vendor's root of trust.
5. An unsafe private config does not stop the gateway from starting; a plugin cannot veto startup in stock OpenClaw. Instead, agent runs, tool calls, model requests and outbound connections are each refused until it is fixed.
6. If privacy-core fails to load, its run gate, policy and door filter are missing. The attested relays still refuse while the config asks for private mode, and the egress proxy is missing, so nothing outside the machine can be reached. A private agent on a local Ollama model could still answer the main gateway unfiltered. Check `openclaw --profile private plugins list` after every update.
7. The run gate covers OpenClaw's own agent runtime. Private mode refuses configs that route agents to external harnesses (Codex, Claude CLI), which do not emit the gate.
8. Sandboxed containers do not use the egress proxy, so private mode requires their network to be off. The sandboxed browser cannot run in private mode yet for the same reason.
9. A local Ollama daemon that is signed in to ollama.com can send "cloud" models off the machine. Private mode refuses cloud model ids; keep the daemon signed out.
10. Skill approval checks the folders OpenClaw 2026.9 loads skills from, at the start of every run. A new kind of skill folder in a later OpenClaw release is not checked until this pack learns it, and a file changed during a run is caught at the next run. Skills shipped with OpenClaw or a plugin are not fingerprinted.
11. Approvals live in the gateway config. On the main gateway they are only as strong as the control over that config: an agent allowed to edit the config could approve its own skill. Private mode makes every write-shaped action wait for you.
12. The skill folders are walked on every run. Fingerprints are cached, but a folder tree with thousands of entries slows every run, and a root with more than 20.000 folders refuses runs until it is trimmed.
13. The skill check catches common dangerous patterns and explains what a skill can do. A determined author can write a harmful skill that no rule matches, and the AI review can be wrong. A GREEN verdict means nothing known was found, not that the skill is safe; the runtime controls above remain the protection.
14. The two door tokens and the private gateway's own token are stored in plain text in each gateway's `.env` file, readable only by your user account, because OpenClaw's A2A channel accepts tokens only as environment variables. They protect a connection between two programs on the same machine; anything able to read them already runs as you. Provider API keys stay in the secret store.
15. Lite mode limits which tools an agent has; it does not contain them. Until an email tool is added to the lite allowlist, a lite private agent cannot read email: it can only chat and use its memory.
