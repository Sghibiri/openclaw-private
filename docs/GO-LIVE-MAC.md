# Go live on a Mac

Bring the whole system up on a MacBook: stock OpenClaw from its official installer, this pack's plugins on top, a main gateway you talk to and a hidden private gateway. Budget about 15 minutes the first time, most of it installing tools.

What you end up with:

| Piece                                                   | Where                                    | Port  |
| ------------------------------------------------------- | ---------------------------------------- | ----- |
| Main gateway (Telegram bot, dashboard, standard agents) | default profile, `~/.openclaw`           | 18789 |
| Private gateway (private agents, attested models only)  | profile `private`, `~/.openclaw-private` | 19789 |
| privacy-core egress proxy (private gateway)             | inside the private gateway               | 19930 |
| Tinfoil relay (private gateway)                         | inside the private gateway               | 19931 |
| Sandbox image for tools                                 | Docker, `openclaw-sandbox:bookworm-slim` | none  |

## 0. Before you start

Keep these in a password manager: the Telegram bot token from @BotFather, your Anthropic API key, your Tinfoil API key (or a Privatemode key for an EU install).

## 1. Tools

```sh
xcode-select --install
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
brew install gh
```

Install [OrbStack](https://orbstack.dev) (or Docker Desktop), open it once, and check that `docker ps` prints an empty table. Without Docker the setup offers lite mode: the private agent can chat and remember but gets no shell, file or browser tools.

## 2. OpenClaw, from the official installer

```sh
curl -fsSL https://openclaw.ai/install.sh | bash
openclaw --version        # 2026.9.6 or newer
```

The installer provisions Node and starts onboarding. Complete it for the **main** gateway: pick Anthropic, paste the Telegram token, keep port 18789, and let it install the background service.

## 3. The pack and the private gateway

```sh
openclaw plugins install openclaw-private     # confirm the prompt: it is not an official OpenClaw plugin
openclaw privacy setup
```

The setup asks which private model service you use (Tinfoil, or Privatemode for EU-only data) and its API key (typed hidden). It lists what it will do and waits for `yes`. Then it:

1. checks Docker and builds the sandbox image (a few minutes the first time); in lite mode this step is skipped
2. stores the key in the private gateway's secret store
3. creates the two door tokens and writes them to each gateway's `.env` file (readable only by you)
4. writes `~/.openclaw-private/openclaw.json`: one `inbox` agent, Tinfoil or Privatemode only, sandbox on, egress through the privacy proxy, skill approval on
5. installs `openclaw-private` and the provider plugin on the private gateway, and starts it as a background service on port 19789
6. adds the door to your main gateway's config and restarts it
7. runs `openclaw --profile private privacy status`, stops with each problem if anything is wrong, and checks that the door opens with its token

It ends with `ok  the door to the private gateway answers and accepts its token`, then `Done`. Anything left for you to do (for example a main gateway it could not restart) is listed under "Finished, with things to do". If a step fails, it says what to fix; run `openclaw privacy setup` again afterwards, and finished steps are skipped or repeated safely. An existing private config is kept unless you pass `--overwrite` (the old one is saved next to it).

To see the plan without changing anything: `openclaw privacy setup --dry-run`. The manual route is in the [appendix](#appendix-manual-setup).

### Connect your email (optional)

```sh
openclaw privacy mail connect
```

It asks for your Gmail address and an app password: open https://myaccount.google.com/apppasswords (2-Step Verification must be on), create one named "OpenClaw Private", and paste the 16 letters (stars show while you paste). It tests the login, then offers the calendar: in Google Calendar on a computer, Settings, your calendar, Integrate calendar, "Secret address in iCal format". Then ask on Telegram: "Ask the inbox agent what is important in my email today."

### Skills on the private gateway

A private agent can use a skill only after you approve it. The example roster gives the inbox agent no skills (`skills: []`), so there is nothing to approve yet. To add one:

1. Check it first, wherever you downloaded it. Nothing is installed or approved by this:

   ```sh
   openclaw --profile private privacy skills check ~/Downloads/<skill-folder>
   ```

   You get a verdict in plain words: GREEN (plain instructions), AMBER (it runs scripts, uses the internet or needs keys: read what it says), or RED (something dangerous, with the file and line). An AI review on your private model adds what the skill really does.

2. If you still want it, put the folder in the agent's workspace, for example `~/.openclaw-private/workspace-inbox/skills/<name>/` (`openclaw --profile private agents list` shows the workspace), and add its name to the agent's `skills` list in `~/.openclaw-private/openclaw.json`.
3. Approve it. The same check runs again; AMBER asks you to type `yes`, RED asks why you trust it and is refused without a reason:

```sh
openclaw --profile private privacy skills approve <name>
openclaw --profile private privacy skills approve <name> --accept-risk "why you trust it"   # RED only
```

Any later change to the folder, by you or anyone else, needs a new approval. Until then the agent's runs are refused with the skill's name. No check proves a skill safe; when in doubt, do not add it.

### Optional: approval on the main gateway too

Add this to `~/.openclaw/openclaw.json`. Then run `openclaw privacy skills list` and approve every skill it shows with `openclaw privacy skills approve <name>`, or move the ones you do not use out of those folders. Every skill there needs approval, including skills in `~/.agents/skills` that other tools installed:

```json5
skills: { workshop: { autonomous: { mode: "off" }, approvalPolicy: "pending" } },
plugins: { entries: { "privacy-core": { config: { skills: { approval: "required" } } } } },
```

The first line is a top-level OpenClaw setting; merge both into the existing blocks.

## 4. Prove it end to end

From Telegram: "Ask the inbox agent what it can do." The chief calls `ask_private_agent`, and the private gateway answers with text only. Then:

```sh
openclaw --profile private privacy status
```

Expect `tinfoil: verified` with a measurement under Attestations, one boundary crossing in the counters, and egress refusals for the gateway's own update and catalog calls. Those refusals are correct: the private gateway talks only to Tinfoil and the hosts you allowed.

## 5. Daily operations

| Task                                    | Command                                                                                                           |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Is everything up                        | `openclaw gateway status` and `openclaw --profile private gateway status`                                         |
| Privacy posture, attestations, refusals | `openclaw --profile private privacy status --since 7d`                                                            |
| Dashboard                               | `openclaw dashboard`                                                                                              |
| Logs                                    | `openclaw logs` (add `--profile private`)                                                                         |
| Take the wheel from a private agent     | `openclaw --profile private privacy control take browser`, later `release browser`                                |
| See or fix what an agent remembers      | `openclaw --profile private privacy memory list --agent inbox`                                                    |
| Check, see and approve skills           | `privacy skills check <folder>`, `privacy skills list`, `privacy skills approve <name>` (add `--profile private`) |
| Approve a private write action          | the Telegram approval prompt, or the dashboard                                                                    |

## 6. Updating

OpenClaw updates itself the normal way. Update the pack on the main gateway, then run the setup again: it installs the same version on the private gateway, keeps your key, tokens and config, and restarts both.

```sh
openclaw update
openclaw plugins update openclaw-private
openclaw privacy setup
openclaw --profile private plugins list      # privacy-core and tinfoil must be loaded
```

Do not run `openclaw --profile private plugins update` directly: the private gateway sends every download, npm's included, to its privacy proxy, which does not allow npm. The setup pauses the proxy for the install and turns it back on.

## 7. If something refuses

| Symptom                                                               | Cause                                             | Fix                                                                                                    |
| --------------------------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Private agents answer "agent runs are refused"                        | A privacy rule is broken                          | `openclaw --profile private privacy status` lists each key to fix                                      |
| `privacy status` shows `tinfoil: FAILED`                              | Attestation failed or the enclave rotated         | Nothing was sent. Retry once; if it persists, check Tinfoil's status page and the `error:` text        |
| "This agent's gateway has skills the owner has not approved"          | A skill is new, changed, or a copy shadows it     | `privacy skills list` shows which; read the folder, then `privacy skills approve <name>`               |
| Egress refusals for a host you need                                   | It is not in the allowlist                        | Add it to `egress.allow` in privacy-core's config, then restart the private gateway                    |
| Chief says the private agent is unreachable                           | A2A tokens differ, or the private gateway is down | Run `openclaw privacy setup` again: it keeps both door tokens in step and restarts the private gateway |
| "Sandbox mode requires Docker"                                        | Docker is not running or the image is missing     | Start OrbStack, then run `openclaw privacy setup` again                                                |
| Gateway fails to start: "custom model providers must declare baseUrl" | The provider block is incomplete                  | Copy the full `models.providers` block from the example                                                |

## Appendix: manual setup

What `openclaw privacy setup` does, by hand.

```sh
# Sandbox image
docker build -t openclaw-sandbox:bookworm-slim - <<'DOCKERFILE'
FROM debian:bookworm-slim
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
  bash ca-certificates curl git jq python3 ripgrep \
  && rm -rf /var/lib/apt/lists/*
RUN useradd --create-home --shell /bin/bash sandbox
USER sandbox
WORKDIR /home/sandbox
CMD ["sleep", "infinity"]
DOCKERFILE

# Provider key in the private gateway's secret store
openclaw --profile private secrets store set TINFOIL_API_KEY

# Door tokens: the same values in both gateways' .env files. OpenClaw's A2A
# channel reads tokens as ${VARIABLES}, not secret-store references.
mkdir -p ~/.openclaw-private
IN=$(openssl rand -hex 32); OUT=$(openssl rand -hex 32); GW=$(openssl rand -hex 32)
printf 'A2A_INBOX_INBOUND=%s\nA2A_INBOX_OUTBOUND=%s\n' "$IN" "$OUT" >> ~/.openclaw/.env
printf 'A2A_INBOX_INBOUND=%s\nA2A_INBOX_OUTBOUND=%s\nOPENCLAW_PRIVATE_GATEWAY_TOKEN=%s\n' "$IN" "$OUT" "$GW" >> ~/.openclaw-private/.env
chmod 600 ~/.openclaw/.env ~/.openclaw-private/.env
```

Write `~/.openclaw-private/openclaw.json` from the private-gateway block in [AGENTS-EXAMPLE](AGENTS-EXAMPLE.md) (EU: [AGENTS-EXAMPLE-EU](AGENTS-EXAMPLE-EU.md)), merge the main-gateway door block into `~/.openclaw/openclaw.json`. In the private file, set `"enabled": false` inside `proxy` for now: the private profile sends npm's downloads to the privacy proxy, which is not running yet. Then:

```sh
openclaw --profile private plugins install openclaw-private
openclaw --profile private plugins install openclaw-private-tinfoil
# now remove "enabled": false from proxy in ~/.openclaw-private/openclaw.json
openclaw --profile private gateway install --port 19789
openclaw gateway restart
openclaw --profile private privacy status
```
