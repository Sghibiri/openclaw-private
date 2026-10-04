import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolvePrivacySettings } from "../../../shared/rules/settings.js";
import {
  buildPrivacyStatusReport,
  formatPrivacyStatusReport,
  parseStatusWindowMs,
} from "./status-cli.js";

describe("openclaw privacy status", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports the posture from config and the audit log without content", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "openclaw-privacy-status-"));
    dirs.push(dir);
    const auditFile = path.join(dir, "privacy-audit.jsonl");
    const now = Date.now();
    const rows = [
      {
        kind: "validation",
        ok: true,
        issues: 0,
        mode: "private",
        residency: "any",
        egressAllow: ["*.tinfoil.sh", "atc.tinfoil.sh"],
        at: new Date(now - 60_000).toISOString(),
      },
      {
        kind: "attestation",
        provider: "tinfoil",
        ok: true,
        enclaveHost: "inference.tinfoil.sh",
        measurement: "0123456789abcdef0123456789abcdef",
        at: new Date(now - 30_000).toISOString(),
      },
      {
        kind: "egress_blocked",
        host: "api.openai.com",
        source: "web_fetch",
        at: new Date(now - 10_000).toISOString(),
      },
    ];
    writeFileSync(auditFile, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
    const report = buildPrivacyStatusReport({
      config: {
        agents: { defaults: { model: "tinfoil/gpt-oss-120b", sandbox: { mode: "all" } } },
        plugins: {
          allow: ["tinfoil", "a2a", "privacy-core"],
          entries: { "privacy-core": { hooks: { allowConversationAccess: true } } },
        },
        proxy: { proxyUrl: "http://127.0.0.1:19930" },
        browser: { evaluateEnabled: false },
        skills: { workshop: { autonomous: { mode: "off" }, approvalPolicy: "pending" } },
      },
      settings: resolvePrivacySettings({
        mode: "private",
        egress: { allow: ["gmail.googleapis.com"] },
        providers: { mistral: { region: "eu" } },
      }),
      since: new Date(now - 3_600_000),
      auditFile,
    });
    expect(report.mode).toBe("private");
    expect(report.policy).toEqual({
      mode: "enforce",
      deny: expect.any(Number),
      approve: expect.any(Number),
      allow: expect.any(Number),
      source: "private default",
    });
    expect(report.audit.lastValidation?.egressAllow).toEqual(["*.tinfoil.sh", "atc.tinfoil.sh"]);
    const text = formatPrivacyStatusReport(report, "1h");
    expect(text).toContain("Privacy mode: private");
    expect(text).toContain("Operator-declared provider regions: mistral=eu");
    expect(text).toContain("Config: ok, agent runs allowed");
    expect(text).toContain("Egress allowlist: *.tinfoil.sh, atc.tinfoil.sh, gmail.googleapis.com");
    expect(text).toContain("Extra egress hosts (egress.allow): gmail.googleapis.com");
    expect(text).toContain("tinfoil: verified");
    expect(text).toContain("measurement 0123456789abcdef…");
    expect(text).toContain("egress refusals: 1");
    expect(text).toContain("    api.openai.com: 1");
    expect(text).toContain("take-the-wheel: help requested 0, taken 0, released 0");
    expect(text).toContain(`Audit log: ${auditFile} (3 rows)`);
  });

  it("explains an install that never booted with a privacy posture", () => {
    const report = buildPrivacyStatusReport({
      config: {},
      settings: resolvePrivacySettings({}),
      since: new Date(),
      auditFile: path.join(os.tmpdir(), "openclaw-privacy-status-missing", "none.jsonl"),
    });
    expect(report.mode).toBe("standard");
    expect(report.policy.source).toBe("standard default");
    const text = formatPrivacyStatusReport(report, "24h");
    expect(text).toContain("Last gateway start: none recorded");
    expect(text).toContain("Attestations (latest per provider):\n  none recorded");
    expect(text).toContain("(not created yet)");
  });

  it("lists the problems that make the gateway refuse runs", () => {
    const report = buildPrivacyStatusReport({
      config: { channels: { telegram: { enabled: true } } },
      settings: resolvePrivacySettings({ mode: "private" }),
      since: new Date(),
      auditFile: path.join(os.tmpdir(), "openclaw-privacy-status-missing", "none.jsonl"),
    });
    const text = formatPrivacyStatusReport(report, "24h");
    expect(text).toMatch(/REFUSING AGENT RUNS: \d+ problems in the privacy config:/u);
    expect(text).toContain("- channels.telegram: private mode allows only the a2a channel");
  });

  it("parses the status window", () => {
    expect(parseStatusWindowMs("24h")).toBe(86_400_000);
    expect(parseStatusWindowMs("7d")).toBe(604_800_000);
    expect(() => parseStatusWindowMs("soon")).toThrow(/use a number followed by m, h or d/u);
  });
});
