# Intake agent for project A

One OpenClaw agent, `intake-a`, that turns a colleague's requests into briefs a coding agent can implement. It lives on the main gateway, talks in one Discord forum channel (one thread per request), reads a read-only copy of project A, and writes exactly one thing: a GitHub issue per request, labeled `agent-ready` or `needs-decision`.

| Piece                                        | What it is                                                                    |
| -------------------------------------------- | ----------------------------------------------------------------------------- |
| `workspace/AGENTS.md`                        | The intake protocol and the definition of ready. Copy to the agent workspace. |
| `workspace/SOUL.md`, `workspace/IDENTITY.md` | Persona: a business and tech hybrid.                                          |
| `workspace/templates/brief.md`               | The brief, which doubles as the prompt handed to the coding agent.            |
| `openclaw.intake.json5`                      | The config to merge into the main gateway's `openclaw.json`.                  |

## How a request flows

1. The colleague opens a post in the `project-a-requests` forum: "Export orders to CSV".
2. The agent restates the request in one sentence and asks for a yes.
3. It reads `/repo`, reports what the code does today with file paths, and checks GitHub for an existing issue.
4. It interviews the colleague, at most three questions per message, business questions first.
5. It drafts the brief, checks it against the definition of ready, and posts it in the thread.
6. On the colleague's confirmation it creates the issue and posts the link. Anything only you can settle sits under "Open decisions"; if one of them blocks, the label is `needs-decision` and no coding agent should pick it up.

You can be in the channel. The agent treats what you say as decisions and what the colleague says as requirements.

## Setup

### 1. Discord

1. Create a private server or use an existing one. Create a **forum** channel named `project-a-requests`.
2. Create a second bot application for this agent (do not reuse the chief-of-staff bot). Invite it with permissions to read and send messages and create public threads in that channel.
3. Note three IDs (enable Developer Mode in Discord, right-click, "Copy ID"): the server, the forum channel, the colleague's user.
4. Store the bot token: `openclaw secrets store set DISCORD_INTAKE_BOT_TOKEN`.

### 2. The read-only clone

The sandbox must never hold a token that can push. Keep the clone on the host and let a cron job refresh it:

```sh
sudo mkdir -p /srv/project-a && sudo git clone --depth 50 git@github.com:OWNER/PROJECT-A.git /srv/project-a
# crontab -e, refresh every ten minutes
*/10 * * * * git -C /srv/project-a pull --ff-only --quiet
```

The clone is bind-mounted read-only at `/repo` inside the agent's sandbox. The deploy key or token used by the host cron never enters the container.

### 3. The issue token

Create a fine-grained personal access token (or a GitHub App installation) limited to the project A repository with **Issues: read and write** and **Contents: read**, nothing else. Save it to a file the sandbox mounts read-only:

```sh
sudo install -d -m 700 /srv/intake-a
sudo sh -c 'umask 077; printf "%s" "<token>" > /srv/intake-a/github-token'
```

The file is mounted at `/run/secrets/github-token`. A mounted file keeps the token out of `docker inspect`, which would show values passed through `sandbox.docker.env`.

### 4. Workspace and config

```sh
mkdir -p ~/.openclaw/workspace-intake-a
cp -r examples/intake-agent/workspace/. ~/.openclaw/workspace-intake-a/
```

Replace `OWNER/PROJECT-A` in `workspace/AGENTS.md` with the real repository. Merge `openclaw.intake.json5` into `~/.openclaw/openclaw.json` after filling the placeholders, then restart the gateway and run `openclaw agents list --bindings` to confirm `intake-a` is bound to the `intake` Discord account.

### 5. First run

Ask the colleague for three past requests, including one bad one, and post them as three threads before giving them the channel. Tune `AGENTS.md` until the bad request ends as `needs-decision` and the good ones produce briefs a developer would accept. Verify in the first real thread that the bot answers inside forum threads without being mentioned; if it stays silent, the guild channel map in the config needs the forum's thread ids or `requireMention: false` at guild level.

## Handing a brief to a coding agent

The issue body is the prompt. Point your coding agent at it:

- OpenClaw `builder` agent: "Implement issue #123 of project A" from Telegram, with the builder's sandbox holding a writable clone.
- Claude Code: open the repository and paste the issue URL, or mention `@claude` on the issue if the GitHub app is installed.

Either way the brief's last section tells the coding agent to branch, test every acceptance criterion, open a PR with the criteria as a checklist, and stop on a blocking open decision instead of guessing.

## What this does not do

- It does not estimate dates or costs, and it does not prioritize. Size is S, M or L.
- It does not certify that a request is worth building. It certifies that a developer can estimate it without a meeting.
- It does not write code, run builds, or touch any repository besides the read-only clone.
