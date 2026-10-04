# OpenClaw Private

Three plugins for [OpenClaw](https://github.com/openclaw/openclaw), the open-source assistant that runs on your own computer and answers you in Telegram, Discord, Slack and 20 other channels. They add one rule, enforced in code rather than in prompts:

> An agent that touches your email, your logins or your documents can only be served by a model you own or a model running in a hardware-verified enclave. Nothing else.

It runs on stock OpenClaw. You install OpenClaw with its official installer, keep updating it with `openclaw update`, and add these plugins on top.

## Two kinds of agents

**Standard agents** work like OpenClaw always has. They use any AI provider you configure and any tool you allow. Use them for research, writing and coding.

**Private agents** live in a second, hidden OpenClaw gateway on the same machine, with these rules:

- They think only with an AI that runs inside a sealed, hardware-verified enclave (Tinfoil, or Privatemode in the EU) or with a model on your own machine (Ollama). Every other model is refused.
- Before every connection the software checks that the enclave runs the exact published build. If the check fails, nothing is sent.
- They reach only the internet hosts you list. Everything else is blocked and written to an audit log.
- Every action that changes something (send, submit, run, write) waits for your approval. Reading is free.
- They use only skills you approved. A skill that changes, even by one character, needs a new approval. Before approving, `openclaw privacy skills check` tells you in plain words what a skill can do and what looks dangerous.
- Your visible assistant can ask a private agent a question and gets back a short text answer. The raw email or page never leaves the private side.
- When a private agent needs you (a login, a captcha), it asks; you take the wheel and hand it back.

One Telegram bot, one dashboard, two houses behind them.

## The plugins

| Plugin         | What it does                                                                                                                                                                                                                                          |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `privacy-core` | Run gate that refuses agent runs on an unsafe config, egress allowlist proxy, CEL action policy (decide, record, then act), the door between gateways (`ask_private_agent` and the reply filter), take-the-wheel, and the `openclaw privacy` commands |
| `tinfoil`      | Tinfoil provider behind a loopback relay that verifies the enclave before every connection                                                                                                                                                            |
| `privatemode`  | Privatemode (Edgeless Systems, Germany) provider, same relay design, for EU-only installs                                                                                                                                                             |

## Install

About 10 minutes on a Mac (Linux works too). You need an API key from [Tinfoil](https://tinfoil.sh), or from [Privatemode](https://www.privatemode.ai) if your data must stay in the EU. [OrbStack](https://orbstack.dev) or Docker is recommended.

|                               | Full mode (Docker running)                             | Lite mode (no Docker) |
| ----------------------------- | ------------------------------------------------------ | --------------------- |
| Private agent can             | chat, remember, run tools in a container               | chat and remember     |
| Shell, file and browser tools | yes, inside a container that sees your files read-only | none                  |
| Install                       | OrbStack first, then the 3 commands                    | the 3 commands        |

The setup offers lite mode when Docker is missing. Switch to full later with `openclaw privacy setup --overwrite`.

```bash
curl -fsSL https://openclaw.ai/install.sh | bash   # 1. OpenClaw itself: connect Telegram when it asks
openclaw plugins install openclaw-private          # 2. this pack (confirm the prompt)
openclaw privacy setup                             # 3. asks two questions, does the rest
```

`openclaw privacy setup` adds the private gateway next to the one you already have and connects them:

- stores your Tinfoil or Privatemode key in OpenClaw's secret store
- creates the door tokens between the two gateways
- writes the private gateway's config (one Inbox agent) and checks it against every privacy rule
- installs the plugins on the private gateway and starts it as a background service
- connects your main gateway, then confirms "privacy config ok"

Then ask your assistant on Telegram: "Ask the inbox agent what it can do." Run it again any time; it repeats or skips finished steps safely. `--dry-run` shows the plan without changing anything. The manual route, step by step, is in [docs/GO-LIVE-MAC.md](docs/GO-LIVE-MAC.md).

## Documentation

- [Where your data goes, and how the rules are enforced](docs/PRIVACY.md)
- [Example roster](docs/AGENTS-EXAMPLE.md) and [EU-only roster](docs/AGENTS-EXAMPLE-EU.md)
- [Go live on a Mac](docs/GO-LIVE-MAC.md)
- [`openclaw privacy` commands](docs/CLI.md)
- Providers: [Tinfoil](docs/providers/tinfoil.md), [Privatemode](docs/providers/privatemode.md)
- [Intake agent for a team](examples/intake-agent/README.md): a colleague's requests become implementable GitHub issues
- [Design history](docs/PLAN.md)

## Development

```bash
npm ci            # includes stock OpenClaw as a dev dependency for types and tests
npm run check     # format, typecheck, tests, build
```

Each plugin is its own npm package (`openclaw-private`, `openclaw-private-tinfoil`, `openclaw-private-privatemode`), built to JavaScript with `npm run build`. To test the npm install path without publishing, pack them and point the wizard at the tarballs:

```bash
npm run build && for p in privacy-core tinfoil privatemode; do (cd plugins/$p && npm pack --pack-destination /tmp/ocp); done
openclaw plugins install npm-pack:/tmp/ocp/openclaw-private-0.1.0.tgz --force
openclaw privacy setup --from /tmp/ocp
```

Plugins use only the public `openclaw/plugin-sdk/*` entry points. A few of them ship without type declarations; `types/openclaw-sdk-untyped.d.ts` declares exactly what the pack uses.

## License

MIT. See [LICENSE](LICENSE) and [NOTICE](NOTICE) for third-party attributions.
