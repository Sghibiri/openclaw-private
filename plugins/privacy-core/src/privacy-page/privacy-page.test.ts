// The Privacy page: who reads email, on which model, whether it is protected,
// and what came back. Built from configs and the metadata-only audit log.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PrivacyAuditRow } from "../../../../shared/audit-types.js";
import { capturePlugin } from "../../../../test/fake-plugin-api.js";
import privacyCore from "../../index.js";
import { buildPrivacyOverview, type PrivacyOverview } from "./overview.js";
import { renderPrivacyPage } from "./render.js";
import { createPrivacyPageHandler, PRIVACY_PAGE_PATH, registerPrivacyPage } from "./route.js";
import { loadPrivacyOverview } from "./sources.js";

const NOW = new Date("2026-10-12T12:00:00Z");
const minutesAgo = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000).toISOString();

const mainConfig = {
  agents: { defaults: { model: "openai/gpt-6-astra@openai:setup-68648839" } },
  channels: { a2a: { peers: { inbox: { url: "http://127.0.0.1:19789/a2a/v1" } } } },
};

const privateConfig = (mail?: Record<string, unknown>) => ({
  gateway: { port: 19789 },
  agents: { defaults: { model: "tinfoil/gpt-oss-120b" }, entries: { inbox: {} } },
  channels: { a2a: { exposeAgents: ["inbox"] } },
  plugins: {
    entries: { "privacy-core": { config: { mode: "private", ...(mail ? { mail } : {}) } } },
  },
});

const row = (event: Record<string, unknown>, at: string): PrivacyAuditRow =>
  ({ ...event, at, schema: 1 }) as PrivacyAuditRow;

const healthyRows = (): PrivacyAuditRow[] => [
  row(
    { kind: "validation", ok: true, issues: 0, mode: "private", residency: "any" },
    minutesAgo(90),
  ),
  row({ kind: "attestation", provider: "tinfoil", ok: true }, minutesAgo(4)),
];

describe("privacy page overview", () => {
  it("shows a healthy private setup with both models, the mailbox and recent activity", () => {
    const overview = buildPrivacyOverview({
      mainConfig,
      privateConfig: privateConfig({ provider: "gmail", address: "owner@example.com" }),
      auditRows: [
        ...healthyRows(),
        row(
          { kind: "boundary_crossing", from: "inbox", to: "a2a", bytes: 77, mode: "summary_only" },
          minutesAgo(30),
        ),
        row({ kind: "mail", action: "search", ok: true, count: 5 }, minutesAgo(31)),
      ],
      privateReachable: true,
      now: NOW,
    });
    expect(overview).toEqual({
      mainModel: { provider: "openai", providerLabel: "OpenAI", model: "gpt-6-astra" },
      inboxAgent: "inbox",
      inboxModel: { provider: "tinfoil", providerLabel: "Tinfoil", model: "gpt-oss-120b" },
      privateGateway: "running",
      protection: "on",
      protectionIssues: 0,
      email: { connected: true, address: "owner@example.com" },
      enclave: { providerLabel: "Tinfoil", ok: true, at: minutesAgo(4) },
      activity: [
        { at: minutesAgo(30), kind: "answer", bytes: 77 },
        { at: minutesAgo(31), kind: "search", count: 5 },
      ],
    });
  });

  it("reports email as not connected when the private config has no mailbox", () => {
    const overview = buildPrivacyOverview({
      mainConfig,
      privateConfig: privateConfig(),
      auditRows: healthyRows(),
      privateReachable: true,
      now: NOW,
    });
    expect(overview.email).toEqual({ connected: false });
  });

  it("says the private gateway is not running when it does not answer", () => {
    const overview = buildPrivacyOverview({
      mainConfig,
      privateConfig: privateConfig(),
      auditRows: healthyRows(),
      privateReachable: false,
      now: NOW,
    });
    expect(overview.privateGateway).toBe("not_running");
  });

  it("says no private gateway is set up when its config is missing", () => {
    const overview = buildPrivacyOverview({
      mainConfig,
      privateConfig: undefined,
      auditRows: [],
      privateReachable: false,
      now: NOW,
    });
    expect(overview.privateGateway).toBe("not_set_up");
    expect(overview.inboxModel).toBeUndefined();
  });

  it("reports refused work and the number of problems from the last start check", () => {
    const overview = buildPrivacyOverview({
      mainConfig,
      privateConfig: privateConfig(),
      auditRows: [
        ...healthyRows(),
        row(
          { kind: "validation", ok: false, issues: 3, mode: "private", residency: "any" },
          minutesAgo(1),
        ),
      ],
      privateReachable: true,
      now: NOW,
    });
    expect([overview.protection, overview.protectionIssues]).toEqual(["refusing", 3]);
  });

  it("says protection is unchecked before the private gateway has recorded a start", () => {
    const overview = buildPrivacyOverview({
      mainConfig,
      privateConfig: privateConfig(),
      auditRows: [],
      privateReachable: true,
      now: NOW,
    });
    expect(overview.protection).toBe("unchecked");
  });

  it("shows the latest enclave check, failed or missing", () => {
    const failed = buildPrivacyOverview({
      mainConfig,
      privateConfig: privateConfig(),
      auditRows: [
        ...healthyRows(),
        row({ kind: "attestation", provider: "tinfoil", ok: false, error: "x" }, minutesAgo(2)),
      ],
      privateReachable: true,
      now: NOW,
    });
    expect(failed.enclave).toEqual({ providerLabel: "Tinfoil", ok: false, at: minutesAgo(2) });
    const missing = buildPrivacyOverview({
      mainConfig,
      privateConfig: privateConfig(),
      auditRows: [],
      privateReachable: true,
      now: NOW,
    });
    expect(missing.enclave).toEqual({ providerLabel: "Tinfoil", ok: false });
  });

  it("has no enclave line when the inbox model is not an attested provider", () => {
    const config = privateConfig();
    config.agents.defaults.model = "ollama/llama3";
    const overview = buildPrivacyOverview({
      mainConfig,
      privateConfig: config,
      auditRows: healthyRows(),
      privateReachable: true,
      now: NOW,
    });
    expect(overview.enclave).toBeUndefined();
  });

  it("lists the last 7 days of activity, newest first, at most 20, without failed reads", () => {
    const rows = [
      row({ kind: "mail", action: "read", ok: true, count: 1 }, minutesAgo(8 * 24 * 60)),
      row({ kind: "mail", action: "read", ok: false, count: 0 }, minutesAgo(5)),
      ...Array.from({ length: 25 }, (_, index) =>
        row({ kind: "mail", action: "calendar", ok: true, count: index }, minutesAgo(100 - index)),
      ),
    ];
    const overview = buildPrivacyOverview({
      mainConfig,
      privateConfig: privateConfig(),
      auditRows: rows,
      privateReachable: true,
      now: NOW,
    });
    expect(overview.activity).toHaveLength(20);
    expect(overview.activity[0]).toEqual({ at: minutesAgo(76), kind: "calendar", count: 24 });
    expect(overview.activity.every((item: { kind: string }) => item.kind === "calendar")).toBe(
      true,
    );
  });

  it("leaves models unknown when a config has none", () => {
    const overview = buildPrivacyOverview({
      mainConfig: {},
      privateConfig: { agents: {} },
      auditRows: [],
      privateReachable: true,
      now: NOW,
    });
    expect([overview.mainModel, overview.inboxModel, overview.inboxAgent]).toEqual([
      undefined,
      undefined,
      "inbox",
    ]);
  });
});

const healthy = (): PrivacyOverview => ({
  mainModel: { provider: "openai", providerLabel: "OpenAI", model: "gpt-6-astra" },
  inboxAgent: "inbox",
  inboxModel: { provider: "tinfoil", providerLabel: "Tinfoil", model: "gpt-oss-120b" },
  privateGateway: "running",
  protection: "on",
  protectionIssues: 0,
  email: { connected: true, address: "owner@example.com" },
  enclave: { providerLabel: "Tinfoil", ok: true, at: minutesAgo(4) },
  activity: [
    { at: "2026-10-08T23:29:14.850Z", kind: "answer", bytes: 77 },
    { at: "2026-10-08T23:28:00.000Z", kind: "search", count: 5 },
  ],
});

const render = (overview: PrivacyOverview) =>
  renderPrivacyPage(overview, { now: NOW, timeZone: "Europe/London", locale: "en-GB" });

/** The page as plain text: tags dropped, entities decoded, whitespace collapsed. */
const textOf = (html: string) =>
  html
    .replace(/<style[\s\S]*?<\/style>/gu, " ")
    .replace(/<[^>]+>/gu, " ")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&amp;", "&")
    .replace(/\s+/gu, " ");

describe("privacy page rendering", () => {
  it("explains who reads email, on which models, in plain words", () => {
    const text = textOf(render(healthy()));
    expect(text).toContain("How your email is handled");
    expect(text).toContain("Main assistant (OpenAI gpt-6-astra)");
    expect(text).toContain("Inbox agent (gpt-oss-120b on Tinfoil)");
    expect(text).toContain("Your main assistant never sees an email. It only gets short answers.");
    expect(text).toContain(
      "To change the Inbox agent's model, run in Terminal: openclaw privacy model",
    );
    expect(text).toContain("Protection is on");
    expect(text).toContain("The Inbox agent reads owner@example.com, read-only");
    expect(text).toContain("Tinfoil's secure hardware verified 4 minutes ago");
    expect(text).toContain("Updated 13:00");
  });

  it("lists recent activity in the owner's time zone, without content", () => {
    const text = textOf(render(healthy()));
    expect(text).toContain("Recent activity (last 7 days)");
    expect(text).toContain(
      "9 Oct, 00:29 Inbox agent answered your main assistant (77 bytes of text)",
    );
    expect(text).toContain("9 Oct, 00:28 Inbox agent searched your email (5 results)");
    expect(textOf(render({ ...healthy(), activity: [] }))).toContain("Nothing in the last 7 days.");
  });

  it("names the command that fixes every red line", () => {
    const cases: Array<[Partial<PrivacyOverview>, string, string]> = [
      [{ privateGateway: "not_set_up" }, "No private gateway is set up", "openclaw privacy setup"],
      [
        { privateGateway: "not_running" },
        "The private gateway is not running",
        "openclaw --profile private gateway start",
      ],
      [
        { protection: "refusing", protectionIssues: 3 },
        "The private gateway is refusing all work",
        "openclaw --profile private privacy status",
      ],
      [{ email: { connected: false } }, "Email not connected", "openclaw privacy mail connect"],
      [
        { enclave: { providerLabel: "Tinfoil", ok: false, at: minutesAgo(2) } },
        "Tinfoil's secure hardware check failed 2 minutes ago",
        "openclaw --profile private privacy status",
      ],
    ];
    for (const [change, headline, command] of cases) {
      const text = textOf(render({ ...healthy(), ...change }));
      expect(text).toContain(headline);
      expect(text).toContain(command);
    }
    expect(textOf(render({ ...healthy(), protection: "refusing", protectionIssues: 3 }))).toContain(
      "Its privacy settings have 3 problems.",
    );
  });

  it("escapes every value and ships no script", () => {
    const html = render({
      ...healthy(),
      email: { connected: true, address: '<script>alert("x")</script>@example.com' },
      inboxModel: { provider: "tinfoil", providerLabel: "Tinfoil", model: "<img src=x onerror=1>" },
    });
    expect(html).not.toMatch(/<script/iu);
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;@example.com");
  });
});

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => Promise<boolean | void>;

async function serve(handler: Handler): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    void handler(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe("privacy page route", () => {
  it("adds a Privacy tab backed by a gateway-authenticated page on every gateway", () => {
    for (const mode of ["standard", "private"] as const) {
      const captured = capturePlugin({
        register: (api: never) => registerPrivacyPage(api, { mode, currentConfig: () => ({}) }),
      });
      expect(captured.all("registerControlUiDescriptor")).toEqual([
        {
          id: "privacy",
          surface: "tab",
          label: "Privacy",
          description: "Who reads your email, on which model, and proof it stays private",
          slug: "privacy",
          icon: "shield",
          path: PRIVACY_PAGE_PATH,
          requiredScopes: ["operator.read"],
        },
      ]);
      const route = captured.first<{ path: string; auth: string; match: string }>(
        "registerHttpRoute",
      );
      expect([route.path, route.auth, route.match]).toEqual([
        PRIVACY_PAGE_PATH,
        "gateway",
        "exact",
      ]);
    }
  });

  it("is registered by Privacy Core on the main and the private gateway", () => {
    for (const mode of ["standard", "private"]) {
      const captured = capturePlugin(privacyCore, { pluginConfig: { mode } });
      expect(captured.all<{ id: string }>("registerControlUiDescriptor").map((d) => d.id)).toEqual([
        "privacy",
      ]);
      expect(captured.all<{ path: string }>("registerHttpRoute").map((r) => r.path)).toEqual([
        PRIVACY_PAGE_PATH,
      ]);
    }
  });

  it("serves the page with no scripts allowed and nothing cached", async () => {
    const server = await serve(
      createPrivacyPageHandler({
        load: async () => healthy(),
        clock: () => NOW,
        onError: () => {},
      }),
    );
    try {
      const response = await fetch(`${server.url}${PRIVACY_PAGE_PATH}`);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
      expect(response.headers.get("content-security-policy")).toBe(
        "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'",
      );
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(await response.text()).toContain("How your email is handled");
    } finally {
      await server.close();
    }
  });

  it("refuses anything but reading", async () => {
    const server = await serve(
      createPrivacyPageHandler({
        load: async () => healthy(),
        clock: () => NOW,
        onError: () => {},
      }),
    );
    try {
      const response = await fetch(`${server.url}${PRIVACY_PAGE_PATH}`, { method: "POST" });
      expect(response.status).toBe(405);
      expect(response.headers.get("allow")).toBe("GET, HEAD");
    } finally {
      await server.close();
    }
  });

  it("answers with a plain error and logs it when the facts cannot be read", async () => {
    const errors: string[] = [];
    const server = await serve(
      createPrivacyPageHandler({
        load: async () => {
          throw new Error("disk gone");
        },
        clock: () => NOW,
        onError: (message) => errors.push(message),
      }),
    );
    try {
      const response = await fetch(`${server.url}${PRIVACY_PAGE_PATH}`);
      expect(response.status).toBe(500);
      expect(await response.text()).toBe(
        "The Privacy page could not be built. The gateway log says why.\n",
      );
      expect(errors).toEqual(["privacy page could not be built: disk gone"]);
    } finally {
      await server.close();
    }
  });
});

describe("privacy page sources", () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), "privacy-page-"));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  const writePrivate = async (config: unknown, rows: PrivacyAuditRow[]) => {
    const dir = path.join(home, ".openclaw-private");
    await mkdir(path.join(dir, "logs"), { recursive: true });
    await writeFile(path.join(dir, "openclaw.json"), JSON.stringify(config));
    await writeFile(
      path.join(dir, "logs", "privacy-audit.jsonl"),
      `${rows.map((r) => JSON.stringify(r)).join("\n")}\nnot json\n`,
    );
  };

  it("on the main gateway, reads the private gateway's config and log and asks if it is up", async () => {
    const ready = await serve(async (req, res) => {
      res.writeHead(req.url === "/readyz" ? 200 : 404, { "content-type": "application/json" });
      res.end(JSON.stringify({ ready: req.url === "/readyz" }));
    });
    try {
      const port = Number(new URL(ready.url).port);
      await writePrivate(
        {
          ...privateConfig({ provider: "gmail", address: "owner@example.com" }),
          gateway: { port },
        },
        healthyRows(),
      );
      const overview = await loadPrivacyOverview({
        mode: "standard",
        ownConfig: mainConfig,
        env: { HOME: home },
        now: NOW,
        signal: AbortSignal.timeout(5_000),
      });
      expect(overview).toMatchObject({
        mainModel: { model: "gpt-6-astra" },
        inboxModel: { model: "gpt-oss-120b" },
        privateGateway: "running",
        protection: "on",
        email: { connected: true, address: "owner@example.com" },
        enclave: { ok: true },
      });
    } finally {
      await ready.close();
    }
  });

  it("says the private gateway is not running when nothing answers on its port", async () => {
    const unused = await serve(async () => {});
    const port = Number(new URL(unused.url).port);
    await unused.close();
    await writePrivate({ ...privateConfig(), gateway: { port } }, healthyRows());
    const overview = await loadPrivacyOverview({
      mode: "standard",
      ownConfig: mainConfig,
      env: { HOME: home },
      now: NOW,
      signal: AbortSignal.timeout(5_000),
    });
    expect(overview.privateGateway).toBe("not_running");
  });

  it("treats an unreadable private config as no private gateway", async () => {
    await mkdir(path.join(home, ".openclaw-private"), { recursive: true });
    await writeFile(path.join(home, ".openclaw-private", "openclaw.json"), "{ json5: true, }");
    const overview = await loadPrivacyOverview({
      mode: "standard",
      ownConfig: mainConfig,
      env: { HOME: home },
      now: NOW,
      signal: AbortSignal.timeout(5_000),
    });
    expect(overview.privateGateway).toBe("not_set_up");
  });

  it("on the private gateway, uses its own config and log and reads the main model", async () => {
    await mkdir(path.join(home, ".openclaw"), { recursive: true });
    await writeFile(path.join(home, ".openclaw", "openclaw.json"), JSON.stringify(mainConfig));
    await writePrivate(privateConfig(), healthyRows());
    const overview = await loadPrivacyOverview({
      mode: "private",
      ownConfig: privateConfig(),
      env: { HOME: home, OPENCLAW_STATE_DIR: path.join(home, ".openclaw-private") },
      now: NOW,
      signal: AbortSignal.timeout(5_000),
    });
    expect(overview).toMatchObject({
      mainModel: { providerLabel: "OpenAI" },
      privateGateway: "running",
      protection: "on",
      enclave: { ok: true },
    });
  });
});
