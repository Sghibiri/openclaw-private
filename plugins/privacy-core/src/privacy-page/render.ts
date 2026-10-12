// The Privacy page as one self-contained HTML document: plain words, no
// scripts, no external resources. Every value is escaped; nothing here is
// content (the overview holds metadata only).
import type { PrivacyActivity, PrivacyOverview } from "./overview.js";

type Tone = "ok" | "bad" | "warn";
type StatusLine = { tone: Tone; headline: string; detail: string };

const MARKS: Record<Tone, { glyph: string; label: string }> = {
  ok: { glyph: "✔", label: "OK" },
  bad: { glyph: "✘", label: "Needs attention" },
  warn: { glyph: "!", label: "Not checked yet" },
};

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

const plural = (count: number, one: string, many = `${one}s`) =>
  `${count} ${count === 1 ? one : many}`;

/** A command the owner types; already escaped, ready for HTML. */
const command = (text: string) => `<code>${escapeHtml(text)}</code>`;
const runInTerminal = (purpose: string, text: string) =>
  `${escapeHtml(purpose)}, run in Terminal: ${command(text)}`;

function relativeTime(at: string, now: Date): string {
  const minutes = Math.floor((now.getTime() - Date.parse(at)) / 60_000);
  if (!Number.isFinite(minutes) || minutes < 1) {
    return "just now";
  }
  if (minutes < 60) {
    return `${plural(minutes, "minute")} ago`;
  }
  const hours = Math.floor(minutes / 60);
  return hours < 24
    ? `${plural(hours, "hour")} ago`
    : `${plural(Math.floor(hours / 24), "day")} ago`;
}

function agentName(agentId: string): string {
  return `${agentId.charAt(0).toUpperCase()}${agentId.slice(1)} agent`;
}

function protectionLine(overview: PrivacyOverview): StatusLine {
  if (overview.privateGateway === "not_set_up") {
    return {
      tone: "bad",
      headline: "No private gateway is set up",
      detail: runInTerminal("To set it up", "openclaw privacy setup"),
    };
  }
  if (overview.privateGateway === "not_running") {
    return {
      tone: "bad",
      headline: "The private gateway is not running",
      detail: `${escapeHtml(`The ${agentName(overview.inboxAgent)} cannot answer until it runs.`)} ${runInTerminal("To start it", "openclaw --profile private gateway start")}`,
    };
  }
  if (overview.protection === "refusing") {
    return {
      tone: "bad",
      headline: "The private gateway is refusing all work",
      detail: `Its privacy settings have ${plural(overview.protectionIssues, "problem")}. ${runInTerminal("To see them", "openclaw --profile private privacy status")}`,
    };
  }
  if (overview.protection === "unchecked") {
    return {
      tone: "warn",
      headline: "Protection not checked yet",
      detail: `The private gateway has not recorded a start check yet. ${runInTerminal("To check now", "openclaw --profile private privacy status")}`,
    };
  }
  return {
    tone: "ok",
    headline: "Protection is on",
    detail: "Private gateway running; settings are safe",
  };
}

function emailLine(overview: PrivacyOverview): StatusLine {
  return overview.email.connected
    ? {
        tone: "ok",
        headline: "Email connected",
        detail: escapeHtml(
          `The ${agentName(overview.inboxAgent)} reads ${overview.email.address}, read-only`,
        ),
      }
    : {
        tone: "bad",
        headline: "Email not connected",
        detail: runInTerminal("To connect", "openclaw privacy mail connect"),
      };
}

function enclaveLine(
  enclave: NonNullable<PrivacyOverview["enclave"]>,
  agent: string,
  now: Date,
): StatusLine {
  const hardware = `${enclave.providerLabel}'s secure hardware`;
  if (!enclave.at) {
    return {
      tone: "warn",
      headline: `${hardware} not checked yet`,
      detail: escapeHtml(`It is checked before the ${agent} first uses the model.`),
    };
  }
  return enclave.ok
    ? {
        tone: "ok",
        headline: `${hardware} verified ${relativeTime(enclave.at, now)}`,
        detail: escapeHtml(
          `Checked before the ${agent} uses the model; nothing is sent if a check fails`,
        ),
      }
    : {
        tone: "bad",
        headline: `${hardware} check failed ${relativeTime(enclave.at, now)}`,
        detail: `Nothing was sent. ${runInTerminal("To see why", "openclaw --profile private privacy status")}`,
      };
}

function activityText(item: PrivacyActivity, agent: string): string {
  switch (item.kind) {
    case "answer":
      return `${agent} answered your main assistant (${plural(item.bytes, "byte")} of text)`;
    case "search":
      return `${agent} searched your email (${plural(item.count, "result")})`;
    case "read":
      return `${agent} read ${plural(item.count, "email")}`;
    case "calendar":
      return `${agent} checked your calendar (${plural(item.count, "event")})`;
  }
}

const STYLE = `
:root { color-scheme: light dark; --text: #24211d; --muted: #6b655c; --line: rgba(0,0,0,.1);
  --surface: rgba(255,255,255,.55); --ok: #1d7a46; --bad: #b42318; --warn: #8a5300; }
@media (prefers-color-scheme: dark) { :root { --text: #ece8e1; --muted: #a39d93; --line: rgba(255,255,255,.12);
  --surface: rgba(255,255,255,.04); --ok: #5cc58a; --bad: #ff8a7a; --warn: #f0b44c; } }
* { box-sizing: border-box; }
html, body { margin: 0; background: transparent; }
body { font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; color: var(--text); }
main { max-width: 760px; margin: 0 auto; padding: 32px 24px 48px; }
header { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 8px; }
h1 { font-size: 28px; line-height: 1.2; margin: 0; }
h2 { font-size: 17px; margin: 0 0 12px; }
.updated, .note { color: var(--muted); font-size: 13px; margin: 0; }
a { color: inherit; }
section { margin-top: 28px; }
.card { border: 1px solid var(--line); border-radius: 12px; background: var(--surface); padding: 18px 20px; }
.flow { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; list-style: none; margin: 0 0 12px; padding: 0; }
.flow li { border: 1px solid var(--line); border-radius: 999px; padding: 4px 12px; font-weight: 600; }
.flow li + li::before { content: "→"; margin: 0 10px 0 -2px; color: var(--muted); font-weight: 400; }
.flow li { position: relative; }
.flow .model { font-weight: 400; color: var(--muted); }
.flow-note { margin: 0; }
.status, .activity { list-style: none; margin: 0; padding: 0; }
.status li { display: grid; grid-template-columns: 28px 1fr; gap: 2px 10px; padding: 12px 0; border-top: 1px solid var(--line); }
.status li:first-child { border-top: 0; padding-top: 0; }
.status li:last-child { padding-bottom: 0; }
.mark { grid-row: span 2; font-weight: 700; font-size: 17px; line-height: 1.35; text-align: center; }
.ok .mark { color: var(--ok); } .bad .mark { color: var(--bad); } .warn .mark { color: var(--warn); }
.headline { font-weight: 600; }
.detail { color: var(--muted); overflow-wrap: anywhere; }
code { font: 13px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; background: var(--line); border-radius: 6px; padding: 1px 6px; color: var(--text); }
.activity li { display: grid; grid-template-columns: 110px 1fr; gap: 12px; padding: 8px 0; border-top: 1px solid var(--line); }
.activity li:first-child { border-top: 0; padding-top: 0; }
.activity time { color: var(--muted); font-variant-numeric: tabular-nums; }
.visually-hidden { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
@media (max-width: 480px) { main { padding: 20px 16px 32px; } .activity li { grid-template-columns: 1fr; gap: 0; } }
`;

export function renderPrivacyPage(
  overview: PrivacyOverview,
  options: { now: Date; timeZone?: string; locale?: string },
): string {
  // Day before month, 24-hour clock: unambiguous wherever the owner is.
  const locale = options.locale ?? "en-GB";
  const zone = options.timeZone ? { timeZone: options.timeZone } : {};
  const clock = new Intl.DateTimeFormat(locale, {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    ...zone,
  });
  const stamp = new Intl.DateTimeFormat(locale, {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    ...zone,
  });
  const agent = agentName(overview.inboxAgent);
  const main = overview.mainModel
    ? ` <span class="model">(${escapeHtml(`${overview.mainModel.providerLabel} ${overview.mainModel.model}`)})</span>`
    : "";
  const inbox = overview.inboxModel
    ? ` <span class="model">(${escapeHtml(`${overview.inboxModel.model} on ${overview.inboxModel.providerLabel}`)})</span>`
    : "";
  const lines = [
    protectionLine(overview),
    emailLine(overview),
    ...(overview.enclave ? [enclaveLine(overview.enclave, agent, options.now)] : []),
  ];
  const status = lines
    .map(
      (line) => `<li class="${line.tone}">
        <span class="mark" aria-hidden="true">${MARKS[line.tone].glyph}</span>
        <span class="headline"><span class="visually-hidden">${MARKS[line.tone].label}: </span>${escapeHtml(line.headline)}</span>
        <span class="detail">${line.detail}</span>
      </li>`,
    )
    .join("\n");
  const activity =
    overview.activity.length === 0
      ? `<p class="note">Nothing in the last 7 days.</p>`
      : `<ul class="activity">${overview.activity
          .map(
            (item) =>
              `<li><time datetime="${escapeHtml(item.at)}">${escapeHtml(stamp.format(new Date(item.at)))}</time><span>${escapeHtml(activityText(item, agent))}</span></li>`,
          )
          .join("\n")}</ul>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Privacy</title>
<style>${STYLE}</style>
</head>
<body>
<main>
  <header>
    <h1>Privacy</h1>
    <p class="updated">Updated <time datetime="${escapeHtml(options.now.toISOString())}">${escapeHtml(clock.format(options.now))}</time> · <a href="">Refresh</a></p>
  </header>
  <section aria-labelledby="flow" class="card">
    <h2 id="flow">How your email is handled</h2>
    <ol class="flow">
      <li>You</li>
      <li>Main assistant${main}</li>
      <li>${escapeHtml(agent)}${inbox}</li>
      <li>Your email</li>
    </ol>
    <p class="flow-note">Your main assistant never sees an email. It only gets short answers.</p>
  </section>
  <section aria-labelledby="status-heading" class="card">
    <h2 id="status-heading" class="visually-hidden">Status</h2>
    <ul class="status">
${status}
    </ul>
  </section>
  <section aria-labelledby="activity-heading">
    <h2 id="activity-heading">Recent activity (last 7 days)</h2>
    ${activity}
  </section>
  <p class="note">This page shows times and counts only. It never shows what an email says.</p>
</main>
</body>
</html>
`;
}
