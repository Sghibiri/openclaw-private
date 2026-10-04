import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolvePrivacySettings } from "../../../../shared/rules/settings.js";
import { validatePrivacyConfig, type HostConfig } from "../../../../shared/rules/validate.js";
import { PACK_VERSION } from "../version.js";
import {
  applyMainConfig,
  buildPrivateConfig,
  DOOR_TOKENS,
  packageSpecs,
  planSetup,
  type PrivateProvider,
  type SetupAnswers,
} from "./plan.js";
import {
  mergeEnv,
  npmFailureSummary,
  readEnvValues,
  runSetup,
  type RunResult,
  type SetupDeps,
} from "./run.js";

const answers = (
  provider: PrivateProvider = "tinfoil",
  port = 19789,
  lite = false,
): SetupAnswers => ({
  provider,
  privatePort: port,
  packVersion: "0.1.0",
  packages: packageSpecs(provider, "0.1.0"),
  ...(lite ? { lite: true } : {}),
});

describe("privacy setup plan", () => {
  it.each(["tinfoil", "privatemode"] as const)(
    "writes a %s private config that passes every privacy rule",
    (provider) => {
      const config = buildPrivateConfig(answers(provider)) as HostConfig;
      const settings = resolvePrivacySettings(config.plugins?.entries?.["privacy-core"]?.config);
      expect(settings.mode).toBe("private");
      expect(validatePrivacyConfig(config, settings)).toEqual([]);
    },
  );

  it.each(["tinfoil", "privatemode"] as const)(
    "writes a %s lite config (no Docker) that passes every privacy rule",
    (provider) => {
      const config = buildPrivateConfig(answers(provider, 19789, true)) as HostConfig;
      const settings = resolvePrivacySettings(config.plugins?.entries?.["privacy-core"]?.config);
      expect(settings.sandbox).toBe("off");
      expect(config.agents?.defaults?.sandbox?.mode).toBe("off");
      expect(validatePrivacyConfig(config, settings)).toEqual([]);
      expect(planSetup(answers(provider, 19789, true)).map((step) => step.kind)).not.toContain(
        "check-docker",
      );
    },
  );

  it("lite mode refuses every tool that would run on the computer directly", () => {
    const base = buildPrivateConfig(answers("tinfoil", 19789, true)) as HostConfig;
    const settings = resolvePrivacySettings(base.plugins?.entries?.["privacy-core"]?.config);
    const withTools = (tools: Record<string, unknown>, where: "entry" | "global" = "entry") => {
      const config = structuredClone(base) as HostConfig & { tools?: unknown };
      if (where === "global") {
        config.tools = tools;
      } else {
        (config.agents!.entries!.inbox as { tools?: unknown }).tools = tools;
      }
      return validatePrivacyConfig(config, settings).map((issue) => issue.path);
    };
    // Shell, files, aliases OpenClaw maps to them, schedulers, MCP tools and wildcards.
    for (const tool of [
      "exec",
      "bash",
      "read",
      "apply-patch",
      "group:fs",
      "browser",
      "computer",
      "cron",
      "automations",
      "fs__write_file",
      "bundle-mcp",
      "e*",
      "*",
    ]) {
      expect(withTools({ profile: "minimal", alsoAllow: [tool], deny: ["gateway"] })).toEqual([
        "agents.entries.inbox.tools.alsoAllow",
      ]);
    }
    expect(withTools({ profile: "minimal", allow: ["Memory_Search"], deny: ["gateway"] })).toEqual(
      [],
    );
    expect(withTools({ profile: "minimal", alsoAllow: ["group:memory"] })).toEqual([
      "agents.entries.inbox.tools.deny",
    ]);
    expect(withTools({ profile: "coding", deny: ["gateway"] })).toEqual([
      "agents.entries.inbox.tools.profile",
    ]);
    expect(withTools({ alsoAllow: ["group:memory"], deny: ["gateway"] })).toEqual([
      "agents.entries.inbox.tools.profile",
    ]);
    expect(
      withTools({ profile: "minimal", alsoAllow: ["exec"], deny: ["gateway"] }, "global"),
    ).toContain("tools.alsoAllow");
    // Full mode still demands the sandbox.
    const full = structuredClone(base);
    (full.plugins!.entries!["privacy-core"] as { config: Record<string, unknown> }).config.sandbox =
      "required";
    const fullSettings = resolvePrivacySettings(full.plugins?.entries?.["privacy-core"]?.config);
    expect(validatePrivacyConfig(full, fullSettings).map((issue) => issue.path)).toContain(
      "agents.defaults.sandbox.mode",
    );
  });

  it("connects the main gateway once, keeping what is there, and replaces a stale door", () => {
    const draft: Record<string, unknown> = {
      plugins: { allow: ["anthropic", "telegram"], entries: { telegram: { enabled: true } } },
      channels: { telegram: { enabled: true } },
    };
    expect(applyMainConfig(draft, answers())).toHaveLength(5);
    expect(draft).toMatchObject({
      plugins: {
        allow: ["anthropic", "telegram", "privacy-core", "a2a"],
        entries: { telegram: { enabled: true }, "privacy-core": { enabled: true } },
      },
      channels: {
        telegram: { enabled: true },
        a2a: {
          enabled: true,
          peers: {
            inbox: {
              url: "http://127.0.0.1:19789/a2a/v1",
              token: `\${${DOOR_TOKENS.inbound}}`,
              outboundToken: `\${${DOOR_TOKENS.outbound}}`,
            },
          },
        },
      },
    });
    expect(applyMainConfig(draft, answers())).toEqual([]);
    expect(applyMainConfig(draft, answers("tinfoil", 20000))).toEqual([
      "updated the door to the private inbox agent (channels.a2a.peers.inbox)",
    ]);
  });

  it("pins every npm package to this release", () => {
    for (const id of ["privacy-core", "tinfoil", "privatemode"]) {
      const pkg = JSON.parse(
        readFileSync(path.join(import.meta.dirname, `../../../${id}/package.json`), "utf8"),
      ) as { version: string };
      expect(pkg.version, id).toBe(PACK_VERSION);
    }
    expect(packageSpecs("privatemode", PACK_VERSION)).toEqual({
      core: `npm:openclaw-private@${PACK_VERSION}`,
      provider: `npm:openclaw-private-privatemode@${PACK_VERSION}`,
    });
  });

  it("edits .env files without touching other lines", () => {
    const before = "# keys\nexport A2A_INBOX_INBOUND=old\n\nTELEGRAM='x y'\n";
    expect(readEnvValues(before, [DOOR_TOKENS.inbound]).get(DOOR_TOKENS.inbound)).toBe("old");
    expect(
      mergeEnv(
        before,
        new Map([
          [DOOR_TOKENS.inbound, "new"],
          [DOOR_TOKENS.outbound, "out"],
        ]),
      ),
    ).toBe("# keys\nA2A_INBOX_INBOUND=new\n\nTELEGRAM='x y'\nA2A_INBOX_OUTBOUND=out\n");
  });
});

type Call = { args: string[]; input?: string; env: Record<string, string | undefined> };

function fakeDeps(
  options: {
    docker?: boolean;
    imageBuilt?: boolean;
    files?: Record<string, string>;
    statusOutput?: string;
    mainRestart?: number;
    doorStatuses?: number[];
    env?: Record<string, string>;
  } = {},
) {
  const calls: Call[] = [];
  const files = new Map<string, string>(Object.entries(options.files ?? {}));
  const renames: string[] = [];
  const logs: string[] = [];
  const mainDraft: Record<string, unknown> = {};
  const doorStatuses = [...(options.doorStatuses ?? [200])];
  let tokens = 0;
  const deps: SetupDeps = {
    run: async (command, args, { input, env }): Promise<RunResult> => {
      calls.push({ args: [command, ...args], ...(input !== undefined ? { input } : {}), env });
      if (command === "docker" && args[0] === "info") {
        return { code: options.docker === false ? 1 : 0, stdout: "28.0.1\n", stderr: "" };
      }
      if (command === "docker" && args[0] === "image") {
        return { code: options.imageBuilt ? 0 : 1, stdout: "", stderr: "" };
      }
      if (args.includes("status")) {
        return {
          code: 0,
          stdout:
            options.statusOutput ??
            `[config] token \${A2A_INBOX_OUTBOUND} resolved {ok}\n${JSON.stringify({ mode: "private", issues: [] }, null, 2)}\n`,
          stderr: "",
        };
      }
      if (args.includes("restart") && !args.includes("--profile")) {
        return { code: options.mainRestart ?? 0, stdout: "", stderr: "no service" };
      }
      return { code: 0, stdout: "", stderr: "" };
    },
    openclaw: { command: "node", args: ["openclaw.mjs"] },
    env: { PATH: "/usr/bin", ...options.env },
    privateStateDir: "/home/u/.openclaw-private",
    mainEnvFile: "/home/u/.openclaw/.env",
    readFile: async (file) => files.get(file),
    fileExists: async (file) => files.has(file),
    writeFileAtomic: async (file, content) => void files.set(file, content),
    rename: async (from, to) => {
      renames.push(`${from} -> ${to}`);
      files.delete(from);
    },
    mutateMainConfig: async (mutate) => mutate(mainDraft),
    probeDoor: async () => doorStatuses.shift() ?? 200,
    sleep: async () => {},
    randomToken: () => `token-${++tokens}`,
    log: (line) => logs.push(line),
  };
  return { deps, calls, files, renames, logs };
}

const run = (
  fake: ReturnType<typeof fakeDeps>,
  extra: Partial<Parameters<typeof runSetup>[0]> = {},
) =>
  runSetup({
    steps: planSetup(answers()),
    answers: answers(),
    providerKey: "tf-secret",
    deps: fake.deps,
    ...extra,
  });

describe("privacy setup run", () => {
  it("stops before changing anything when Docker is not running", async () => {
    const fake = fakeDeps({ docker: false });
    const outcome = await run(fake);
    expect(outcome).toMatchObject({ ok: false, step: "check-docker" });
    expect(outcome.ok === false && outcome.message).toContain("orbstack.dev");
    expect(fake.calls).toHaveLength(1);
    expect(fake.files.size).toBe(0);
  });

  it("stores the key, writes matching door tokens, installs, connects, verifies and opens the door", async () => {
    const fake = fakeDeps({ imageBuilt: true });
    expect(await run(fake)).toEqual({ ok: true, warnings: [] });
    const stored = fake.calls.filter((call) => call.args.includes("secrets"));
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ input: "tf-secret" });
    expect(
      fake.calls.some((call) =>
        call.args.some((arg) => arg.includes("tf-secret") || arg.startsWith("token-")),
      ),
    ).toBe(false);
    expect(fake.files.get("/home/u/.openclaw/.env")).toBe(
      "A2A_INBOX_INBOUND=token-1\nA2A_INBOX_OUTBOUND=token-2\n",
    );
    expect(fake.files.get("/home/u/.openclaw-private/.env")).toBe(
      "A2A_INBOX_INBOUND=token-1\nA2A_INBOX_OUTBOUND=token-2\nOPENCLAW_PRIVATE_GATEWAY_TOKEN=token-3\n",
    );
    const written = JSON.parse(fake.files.get("/home/u/.openclaw-private/openclaw.json") ?? "{}");
    expect(written.gateway.auth.token).toBe("${OPENCLAW_PRIVATE_GATEWAY_TOKEN}");
    expect(
      fake.calls
        .filter((call) => call.args.includes("install"))
        .map((call) => call.args.slice(4, 7)),
    ).toEqual([
      ["plugins", "install", "npm:openclaw-private@0.1.0"],
      ["plugins", "install", "npm:openclaw-private-tinfoil@0.1.0"],
      ["gateway", "install", "--force"],
    ]);
    expect(fake.logs.at(-1)).toContain("the door to the private gateway answers");
  });

  it("re-runs keep the door tokens already written, so both gateways stay in step", async () => {
    const fake = fakeDeps({
      imageBuilt: true,
      files: {
        "/home/u/.openclaw/.env":
          "TELEGRAM_BOT_TOKEN=t\nA2A_INBOX_INBOUND=main-in\nA2A_INBOX_OUTBOUND=main-out\n",
        "/home/u/.openclaw-private/.env":
          "A2A_INBOX_INBOUND=stale\nA2A_INBOX_OUTBOUND=stale\nOPENCLAW_PRIVATE_GATEWAY_TOKEN=gw\n",
        "/home/u/.openclaw-private/openclaw.json": JSON.stringify(buildPrivateConfig(answers())),
      },
    });
    expect(await run(fake)).toMatchObject({ ok: true });
    expect(fake.files.get("/home/u/.openclaw/.env")).toBe(
      "TELEGRAM_BOT_TOKEN=t\nA2A_INBOX_INBOUND=main-in\nA2A_INBOX_OUTBOUND=main-out\n",
    );
    expect(fake.files.get("/home/u/.openclaw-private/.env")).toBe(
      "A2A_INBOX_INBOUND=main-in\nA2A_INBOX_OUTBOUND=main-out\nOPENCLAW_PRIVATE_GATEWAY_TOKEN=gw\n",
    );
  });

  it("gives private steps their own folder and keeps secrets out of every child's environment", async () => {
    const fake = fakeDeps({
      imageBuilt: true,
      env: {
        OPENCLAW_STATE_DIR: "/srv/main",
        OPENCLAW_CONFIG_PATH: "/srv/main/openclaw.json",
        OPENCLAW_GATEWAY_TOKEN: "main-gw",
        A2A_INBOX_INBOUND: "inherited",
        TF_KEY: "tf-secret",
      },
    });
    await run(fake, { secretEnvNames: ["TF_KEY"] });
    expect(fake.calls.length).toBeGreaterThan(5);
    for (const call of fake.calls) {
      expect(call.env.TF_KEY).toBeUndefined();
      expect(call.env.A2A_INBOX_INBOUND).toBeUndefined();
      if (call.args.includes("--profile")) {
        // Unset, so `--profile private` resolves its own default folder.
        expect(call.env.OPENCLAW_STATE_DIR).toBeUndefined();
        expect(call.env.OPENCLAW_CONFIG_PATH).toBeUndefined();
        expect(call.env.OPENCLAW_GATEWAY_TOKEN).toBeUndefined();
      }
    }
  });

  it("refuses to reuse a private config made for another provider, and replaces it on request", async () => {
    const fake = fakeDeps({
      imageBuilt: true,
      files: {
        "/home/u/.openclaw-private/openclaw.json": JSON.stringify(
          buildPrivateConfig(answers("privatemode")),
        ),
      },
    });
    const outcome = await run(fake);
    expect(outcome).toMatchObject({ ok: false, step: "write-private-config" });
    expect(outcome.ok === false && outcome.message).toContain("--overwrite");
    const replaced = fakeDeps({
      imageBuilt: true,
      files: { "/home/u/.openclaw-private/openclaw.json": "{}" },
    });
    expect(await run(replaced, { overwrite: true })).toMatchObject({ ok: true });
    expect(replaced.renames[0]).toMatch(/openclaw\.json -> .*openclaw\.json\.before-setup-\d+$/u);
  });

  it("installs plugins with the private egress proxy paused, then turns it back on", async () => {
    const config = "/home/u/.openclaw-private/openclaw.json";
    for (const existing of [false, true]) {
      const fake = fakeDeps({
        imageBuilt: true,
        ...(existing ? { files: { [config]: JSON.stringify(buildPrivateConfig(answers())) } } : {}),
      });
      const proxyDuringInstall: unknown[] = [];
      const run = fake.deps.run;
      fake.deps.run = async (command, args, options) => {
        if (args.includes("plugins") && args.includes("install")) {
          proxyDuringInstall.push(JSON.parse(fake.files.get(config) ?? "{}").proxy);
        }
        return run(command, args, options);
      };
      const outcome = await runSetup({
        steps: planSetup(answers()),
        answers: answers(),
        providerKey: "k",
        deps: fake.deps,
      });
      expect(outcome).toMatchObject({ ok: true });
      expect(proxyDuringInstall).toEqual([
        { proxyUrl: "http://127.0.0.1:19930", enabled: false },
        { proxyUrl: "http://127.0.0.1:19930", enabled: false },
      ]);
      expect(JSON.parse(fake.files.get(config) ?? "{}").proxy).toEqual({
        proxyUrl: "http://127.0.0.1:19930",
      });
    }
    // While paused, the privacy rules refuse private agent runs.
    const paused = buildPrivateConfig(answers()) as HostConfig;
    paused.proxy = { ...paused.proxy, enabled: false };
    const settings = resolvePrivacySettings(paused.plugins?.entries?.["privacy-core"]?.config);
    expect(validatePrivacyConfig(paused, settings).map((issue) => issue.path)).toContain(
      "proxy.proxyUrl",
    );
  });

  it("runs without Docker in lite mode and will not silently swap modes", async () => {
    const lite = fakeDeps({ docker: false });
    const outcome = await run(lite, {
      steps: planSetup(answers("tinfoil", 19789, true)),
      answers: answers("tinfoil", 19789, true),
    });
    expect(outcome).toMatchObject({ ok: true });
    expect(lite.calls.some((call) => call.args[0] === "docker")).toBe(false);
    const written = JSON.parse(lite.files.get("/home/u/.openclaw-private/openclaw.json") ?? "{}");
    expect(written.plugins.entries["privacy-core"].config.sandbox).toBe("off");
    // A lite config is not reused for a full setup without --overwrite.
    const toFull = fakeDeps({
      imageBuilt: true,
      files: {
        "/home/u/.openclaw-private/openclaw.json": JSON.stringify(
          buildPrivateConfig(answers("tinfoil", 19789, true)),
        ),
      },
    });
    const refused = await run(toFull);
    expect(refused).toMatchObject({ ok: false, step: "write-private-config" });
    expect(refused.ok === false && refused.message).toContain("lite mode");
    expect(await run(toFull, { overwrite: true })).toMatchObject({ ok: true });
  });

  it("retries a failed plugin install once and then shows what npm said", async () => {
    const npmOutput = [
      "npm error code ECONNRESET",
      "npm error syscall read",
      "npm error errno ECONNRESET",
      "npm error network request to https://registry.npmjs.org/openclaw-private-tinfoil failed, reason: read ECONNRESET",
      "npm error network This is a problem related to network connectivity.",
      "npm error If you are behind a proxy, please make sure that the 'proxy' config is set properly.",
      "npm error A complete log of this run can be found in: /Users/u/.npm/_logs/x-debug-0.log",
    ].join("\n");
    expect(npmFailureSummary(npmOutput)).toBe(
      "npm error code ECONNRESET / npm error syscall read / npm error errno ECONNRESET / npm error network request to https://registry.npmjs.org/openclaw-private-tinfoil failed, reason: read ECONNRESET / npm error A complete log of this run can be found in: /Users/u/.npm/_logs/x-debug-0.log",
    );
    for (const failures of [1, 2]) {
      const fake = fakeDeps({ imageBuilt: true });
      let left = failures;
      const run = fake.deps.run;
      fake.deps.run = async (command, args, options) => {
        if (args.includes("install") && args.some((arg) => arg.includes("tinfoil")) && left > 0) {
          left -= 1;
          return { code: 1, stdout: "", stderr: npmOutput };
        }
        return run(command, args, options);
      };
      const outcome = await runSetup({
        steps: planSetup(answers()),
        answers: answers(),
        providerKey: "k",
        deps: fake.deps,
      });
      if (failures === 1) {
        expect(outcome).toMatchObject({ ok: true });
      } else {
        expect(outcome).toMatchObject({ ok: false, step: "install-plugin" });
        expect(outcome.ok === false && outcome.message).toContain("ECONNRESET");
      }
    }
  });

  it("gives a stuck install a time limit and does not retry it", async () => {
    const fake = fakeDeps({ imageBuilt: true });
    const timeouts: Array<number | undefined> = [];
    let installs = 0;
    const run = fake.deps.run;
    fake.deps.run = async (command, args, options) => {
      if (args.includes("install") && args.includes("plugins")) {
        timeouts.push(options.timeoutMs);
        installs += 1;
        return { code: 124, stdout: "", stderr: "no result after 5 minutes, so it was stopped." };
      }
      return run(command, args, options);
    };
    const outcome = await runSetup({
      steps: planSetup(answers()),
      answers: answers(),
      providerKey: "k",
      deps: fake.deps,
    });
    expect(outcome).toMatchObject({ ok: false, step: "install-plugin" });
    expect(outcome.ok === false && outcome.message).toContain("no result after 5 minutes");
    expect(installs).toBe(1);
    expect(timeouts).toEqual([5 * 60_000]);
  });

  it("does not claim success it cannot back", async () => {
    const restartFails = fakeDeps({ imageBuilt: true, mainRestart: 1 });
    const outcome = await run(restartFails);
    expect(outcome.ok && outcome.warnings[0]).toContain("openclaw gateway restart");

    const wrongMode = fakeDeps({
      imageBuilt: true,
      statusOutput: JSON.stringify({ mode: "standard", issues: [] }),
    });
    expect(await run(wrongMode)).toMatchObject({ ok: false, step: "verify" });

    const problems = fakeDeps({
      imageBuilt: true,
      statusOutput: JSON.stringify({
        mode: "private",
        issues: [{ path: "proxy.proxyUrl", message: "set it" }],
      }),
    });
    const failed = await run(problems);
    expect(failed.ok === false && failed.message).toContain("proxy.proxyUrl: set it");

    const refused = fakeDeps({ imageBuilt: true, doorStatuses: [0, 0, 401] });
    expect(await run(refused)).toMatchObject({ ok: false, step: "check-door" });
  });
});

describe("hidden key prompt", () => {
  it("shows a star per character, drops paste markers, handles backspace, Enter and Ctrl+C", async () => {
    const { hiddenInputStep } = await import("./cli.js");
    const pasted = hiddenInputStep("", "\u001b[200~tk_abc123\u001b[201~");
    expect(pasted).toEqual({
      value: "tk_abc123",
      echo: "*********",
      done: false,
      cancelled: false,
    });
    expect(hiddenInputStep("tk_abc123", "\u007f")).toMatchObject({
      value: "tk_abc12",
      echo: "\b \b",
    });
    expect(hiddenInputStep("", "\u007f")).toMatchObject({ value: "", echo: "" });
    expect(hiddenInputStep("tk", "x\r")).toEqual({
      value: "tkx",
      echo: "*",
      done: true,
      cancelled: false,
    });
    expect(hiddenInputStep("tk", "\u0003")).toMatchObject({ done: true, cancelled: true });
  });
});
