# `openclaw privacy`

Commands added by the `privacy-core` plugin. Add `--profile private` before `privacy` to work on the private gateway, for example `openclaw --profile private privacy status`.

## `openclaw privacy setup`

```
openclaw privacy setup [--provider tinfoil|privatemode] [--key-env <VAR>] [--dry-run] [--overwrite] [--lite] [--port <port>] [--yes]
```

Adds the private gateway next to this one and connects them, in one guided step. It asks for the private model service and its API key (or takes `--provider` and `--key-env` for scripts), shows the plan, waits for `yes`, then: checks Docker and builds the sandbox image; stores the key in the private gateway's secret store; writes the door tokens to both gateways' `.env` files; writes `~/.openclaw-private/openclaw.json`; installs `openclaw-private` and the provider plugin there (pinned to this release) and starts it as a service; adds the door to this gateway's config and restarts it; then checks `openclaw --profile private privacy status` and that the door opens with its token.

Every step can run again safely: door tokens already written are reused, so both gateways stay in step, and the private service is reinstalled to load the current config. Without a terminal it needs `--yes`. An existing private config is kept unless `--overwrite` (the old one is saved next to it). `--dry-run` prints the plan. When Docker is not running it offers lite mode, or `--lite` chooses it up front: no Docker steps, `sandbox: "off"` in privacy-core's config, and the inbox agent on the `minimal` tool profile plus memory tools only (no shell, file, browser, scheduler or MCP tools). A lite config is not reused for a full setup, or the other way round, without `--overwrite`. `--from <folder>` installs from `npm pack` tarballs instead of npm, for testing.

## `openclaw privacy status`

```
openclaw privacy status [--since 24h] [--json]
```

Read-only. Reads the config and the metadata-only audit log at `<stateDir>/logs/privacy-audit.jsonl`, and never prints prompts, keys or page content. It prints, in order:

- **Posture:** mode, residency, operator-declared provider regions, the door boundary (private gateways) and the action policy with its rule counts.
- **Problems:** `Config: ok, agent runs allowed`, or `REFUSING AGENT RUNS` followed by every problem with the exact key to fix. While any problem stands, the run gate refuses every agent run.
- **Egress allowlist** (private gateways): the hosts the egress proxy lets through right now.
- **Last gateway start:** the check privacy-core recorded when the gateway last started with a privacy posture.
- **Attestations:** the latest outcome per attested provider with the enclave host, measurement fingerprint, release digest and whether the vendor rotated its manifest.
- **Counters for the window** (`--since 30m`, `24h`, `7d`; default `24h`): attestation failures, egress refusals per host, action outcomes (allowed, refused, approval required, human had control), boundary crossings with the bytes that left the private gateway, and take-the-wheel handoffs.

`--json` prints the same report as one object.

## `openclaw privacy control`

The person's side of take-the-wheel. The agent can only raise its hand with the `request_help` tool; it never takes or hands back control itself. While a person holds control, the action gateway refuses every non-read action for that agent instead of queuing it.

```
openclaw privacy control list [--json]
openclaw privacy control take <agentId> [--json]
openclaw privacy control release <agentId> [--json]
```

These talk to the running gateway (`privacy.control.list`, `.take`, `.release`); `take` and `release` need `operator.admin`. Use the usual `--url`, `--port`, `--token` or `--password` flags to reach a non-default gateway. Every take and release is a `control` row in the audit log.

## `openclaw privacy skills`

Skill approval. An agent run is refused while any skill folder the gateway would load for that agent has a fingerprint you have not approved. Always on for a private gateway; on a standard gateway, set `skills.approval: "required"` in privacy-core's config.

```
openclaw privacy skills check <name-or-folder> [--no-ai] [--json]
openclaw privacy skills list [--agent <id>] [--json]
openclaw privacy skills approve <name-or-folder> [--no-ai] [--yes] [--accept-risk "<reason>"]
openclaw privacy skills revoke <name>
```

- `check` is a security check in plain words. It approves nothing, so use it on a skill before you add it. It reads every file (the first 1 MiB of each) and reports:
  - **What it can do:** scripts it runs, hosts its commands contact (marked when a private gateway's egress proxy would block them, including plain HTTP), secrets it needs, software it installs, images it includes. A link in the instructions is not counted as a contact unless the line runs a command.
  - **Warnings, with file and line:** RED for instructions to hide things from you, to ignore the agent's rules, or to send your data to an outside address; downloading and running code; scrambled code; reading passwords, SSH or cloud keys, shell history, crypto wallets or browser data; sending mail, messages or documents to another computer; raw network tools; wiping the home folder or a disk; starting itself again after a restart; crypto mining; invisible characters; programs; links to files outside the skill's folder. AMBER for leaving things out when talking to you, uploads, reading or copying personal folders locally, deleting files, changing shell startup files, reading all environment variables, hidden HTML notes with instructions, scrambled data, keys written into files, administrator rights, AppleScript, letters mixed from different alphabets, files named like images that are not, binary files, and a `.git` folder. Sentences and commands wrapped over two lines are checked too. Images are recognised by their content, not their name; only real Finder `.DS_Store` files are skipped. Keys in the common provider formats are never printed, and text from a skill cannot add, change or erase report lines (control characters and line breaks are removed).
  - **AI review** (skip with `--no-ai`): the gateway's default model, through OpenClaw, reads the skill as untrusted data (SKILL.md first, up to 60.000 characters, keys hidden; files whose names suggest secrets, `.git` files and binaries left out) and says in one sentence what it does, with its concerns. On a private gateway that is the attested or local model; while the private config has problems the review is skipped. On the main gateway the skill's text goes to your normal provider. The AI can make the verdict stricter, never milder; if its answer holds several verdicts, the strictest counts. A review that fails, is cut off, or sees only part of the skill keeps the verdict at least AMBER.
  - **Verdict:** GREEN plain instructions only; AMBER understand it first; RED dangerous.
- `approve` runs the same check first. AMBER asks you to type `yes` (or pass `--yes`). RED asks you to type why you trust it (or pass `--accept-risk "<reason>"`); without a reason nothing is approved. The verdict and any reason go into the audit log. The approval covers exactly the bytes the check read, so a file swapped during the check is not approved.
- `approve <name>` fingerprints every current copy of the skill (SHA-256 over the folder name and every file's path, content and executable bit) and adds the fingerprints to `plugins.entries.privacy-core.config.skills.approved.<name>`. Read the files first: the approval covers them exactly as they are now.
- `approve <folder>` approves one skill folder by path and adds it to that name's approvals. Use it for a copy in a run's own execution workspace (a git worktree), which the refusal message names.
- `revoke` removes every fingerprint approved under that name, and the same fingerprints anywhere else they are stored.

Checked folders: the agent's workspace `skills/` and `.agents/skills/` (and a run's execution workspace), `<stateDir>/skills`, the agent's Skill Workshop folder, the personal skill library, `skills.load.extraDirs`, and `~/.agents/skills` (under your home and under `OPENCLAW_HOME`) when the gateway uses the default state folder, as OpenClaw does. Every stored revision in the personal skill library counts as its own skill. Every skill folder there needs approval, even one missing from the agent's `skills` list: the pack does not copy OpenClaw's naming and visibility rules, so it cannot be fooled by a mismatch. Symlinked folders are checked under each name. Skills shipped with OpenClaw or an installed plugin are trusted with that code and are not fingerprinted; the agent's `skills` list still decides which of them it sees.

Each approval, revocation and refusal is a `skill` row in the audit log.

## `openclaw privacy memory`

See, edit and delete what an agent remembers. Entries are the non-heading lines of `MEMORY.md` and `memory/*.md` in the agent's workspace; each has an id of the form `file#line`.

```
openclaw privacy memory list [--agent <id>] [--json]
openclaw privacy memory show <id> [--agent <id>] [--json]
openclaw privacy memory edit <id> "<new text>" [--agent <id>] [--json]
openclaw privacy memory delete <id> [--agent <id>] [--json]
```

Edits change the files directly. Run `openclaw memory index --agent <id>` afterwards to refresh memory search.
