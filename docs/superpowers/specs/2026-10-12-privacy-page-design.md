# Privacy page: design

Approved by the owner on 2026-10-12.

## Problem

The owner sees only the main gateway's dashboard and its standard models. Nothing there shows that a separate private gateway reads email, that it uses only Tinfoil, or whether Tinfoil's enclave was verified. The only view is `openclaw --profile private privacy status` in a terminal, written for engineers.

## Goal

A "Privacy" item in the dashboard sidebar, on both the main and the private gateway, that answers in plain words:

1. How email is handled: which assistant and model you talk to, which agent and model read email, and that only short answers come back.
2. Whether protection is on, email is connected (and which address), and Tinfoil's hardware was verified recently.
3. Recent activity: answers the Inbox agent sent back (time and size) and email searches, reads and calendar lookups (time and count). Never content.

Every red line names the exact command that fixes it.

## Out of scope

- Connecting email from the page. Plugin pages in stock OpenClaw are framed read-only (`sandbox="allow-scripts"`, read-scope grant), so a form that takes the Gmail app password would need "Custom plugin UI" in Settings > Labs. The owner chose to keep `openclaw privacy mail connect` in Terminal.
- Any change to trust tables, egress allowlists, credential storage or attestation.

## Approach

Stock OpenClaw lets any loaded plugin add a sidebar tab (`api.session.controls.registerControlUiDescriptor` with `surface: "tab"` and a `path`) that the dashboard renders in a sandboxed frame, served by the plugin's own gateway-authenticated HTTP route (`api.registerHttpRoute` with `auth: "gateway"`). Neither is limited to bundled plugins, neither needs the Labs setting, and neither is part of the declared surface the owner consented to. Both exist in the SDK floor (2026.9.6) and the installed 2026.10.1.

Privacy Core registers both on every gateway. The route answers GET/HEAD with a server-rendered HTML page: no scripts, no external resources, every value HTML-escaped, `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'`, `Cache-Control: no-store`. Other methods get 405.

## Data

All metadata, read on each request:

| Fact                      | Source                                                                                                         |
| ------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Main assistant model      | main config `agents.defaults.model`                                                                            |
| Inbox agent and its model | private config `channels.a2a.exposeAgents[0]`, then that agent's model or `agents.defaults.model`              |
| Email connected, address  | private config `plugins.entries.privacy-core.config.mail.address`                                              |
| Private gateway running   | on main: `GET http://127.0.0.1:<private gateway.port, default 19789>/readyz` (2 s timeout); on private: itself |
| Protection on             | private audit, last `validation` row                                                                           |
| Enclave verified          | private audit, latest `attestation` row for the Inbox model's provider (shown only for attested providers)     |
| Activity                  | private audit, `boundary_crossing` and successful `mail` rows of the last 7 days, newest first, at most 20     |

The gateway's own config comes from the live authored config; the other gateway's from its `openclaw.json` (plain JSON; anything unreadable shows as unknown). State dirs: the gateway's own from `resolveStateDir`; the other one is `~/.openclaw-private` (from main) or `~/.openclaw` (from private), the same convention `privacy mail` uses. The audit file is read from its last 4 MiB at most.

## Wording

```
How your email is handled
  You → Main assistant (OpenAI gpt-6-astra) → asks → Inbox agent (gpt-oss-120b on Tinfoil) → Gmail
  Your main assistant never sees an email. It only gets short answers.

✔ Protection is on — Private gateway running; settings are safe
✘ Email not connected — To connect, run in Terminal: openclaw privacy mail connect
✔ Tinfoil's secure hardware verified 4 minutes ago

Recent activity (last 7 days)
  9 Oct, 00:29  Inbox agent answered your main assistant (77 characters)
```

Red lines and their fixes:

- No private config: "No private gateway is set up." Fix: `openclaw privacy setup`.
- Private gateway not answering: "The private gateway is not running, so the Inbox agent cannot answer." Fix: `openclaw --profile private gateway start`.
- Last validation refused: "The private gateway is refusing all work: its privacy settings have N problems." Fix: `openclaw --profile private privacy status`.
- Latest attestation failed: "Tinfoil's secure hardware check failed …, so nothing was sent." Fix: `openclaw --profile private privacy status`.

## Release

Privacy Core, Tinfoil and Privatemode go to 0.3.0 together (pack lockstep; `privacy setup` installs the same release on both gateways). Live Tinfoil keeps running 0.2.0; its code is unchanged. Deploy follows the proven route: isolated build and checks, scratch gateway, verified backups, main via gateway-side install, private via stop / cache-only install / start, then live checks and dashboard screenshots.

## Testing

- Overview builder: connected and not connected mail, gateway down, refused validation, failed and missing attestation, activity window and order, unknown models.
- Renderer: escaping, every red line names its command, no scripts.
- Route: GET 200 with the security headers, POST 405, registration on both modes.
