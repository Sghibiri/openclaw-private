import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parsePrivacyAuditRows, summarizePrivacyAuditLog } from "./audit-summary.js";

const T0 = Date.parse("2026-09-19T10:00:00.000Z");
const at = (offsetMinutes: number) => new Date(T0 + offsetMinutes * 60_000).toISOString();

describe("privacy audit summary", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("summarizes the latest attestation per provider, the window counters and the last validation", () => {
    const lines = [
      { kind: "validation", ok: false, issues: 2, mode: "private", residency: "any", at: at(-600) },
      { kind: "attestation", provider: "tinfoil", ok: false, error: "boom", at: at(-500) },
      {
        kind: "validation",
        ok: true,
        issues: 0,
        mode: "private",
        residency: "eu",
        egressAllow: ["api.privatemode.ai"],
        at: at(-400),
      },
      { kind: "attestation", provider: "tinfoil", ok: true, measurement: "m1", at: at(-30) },
      { kind: "attestation", provider: "privatemode", ok: false, error: "stale", at: at(-20) },
      { kind: "egress_blocked", host: "api.openai.com", source: "web_fetch", at: at(-10) },
      { kind: "egress_blocked", host: "api.openai.com", source: "web_fetch", at: at(-9) },
      { kind: "egress_blocked", host: "old.example.com", source: "web_fetch", at: at(-5000) },
      {
        kind: "action",
        tool: "exec",
        intent: "run_command",
        agentId: "inbox",
        host: "",
        outcome: "approval_required",
        rule: "r",
        source: "tool",
        mode: "enforce",
        at: at(-8),
      },
      {
        kind: "boundary_crossing",
        from: "inbox",
        to: "main",
        bytes: 120,
        mode: "summary_only",
        at: at(-7),
      },
      {
        kind: "boundary_crossing",
        from: "inbox",
        to: "main",
        bytes: 80,
        mode: "summary_only",
        at: at(-6),
      },
      { kind: "control", agentId: "browser", event: "help_requested", by: "agent", at: at(-4) },
      { kind: "control", agentId: "browser", event: "taken", by: "operator", at: at(-3) },
    ];
    const dir = mkdtempSync(path.join(os.tmpdir(), "openclaw-privacy-summary-"));
    dirs.push(dir);
    const file = path.join(dir, "privacy-audit.jsonl");
    writeFileSync(
      file,
      `${lines.map((row) => JSON.stringify(row)).join("\n")}\nnot json\n{"x":1}\n`,
    );
    const summary = summarizePrivacyAuditLog({
      file,
      since: new Date(T0 - 60 * 60_000),
    });
    expect(summary.exists).toBe(true);
    expect(summary.rows).toBe(lines.length);
    expect(summary.malformedLines).toBe(2);
    expect(summary.lastValidation).toMatchObject({
      ok: true,
      residency: "eu",
      egressAllow: ["api.privatemode.ai"],
    });
    expect(summary.attestations.map((row) => [row.provider, row.ok])).toEqual([
      ["privatemode", false],
      ["tinfoil", true],
    ]);
    expect(summary.window).toEqual({
      egressBlocked: { total: 2, byHost: [{ host: "api.openai.com", count: 2 }] },
      actions: { allowed: 0, refused: 0, approval_required: 1, human_has_control: 0 },
      boundaryCrossings: { total: 2, bytes: 200 },
      attestationFailures: 1,
      control: { help_requested: 1, secret_requested: 0, taken: 1, released: 0 },
    });
  });

  it("treats a missing log as empty", () => {
    const summary = summarizePrivacyAuditLog({
      file: path.join(os.tmpdir(), "openclaw-privacy-summary-missing", "nope.jsonl"),
      since: new Date(T0),
    });
    expect(summary.exists).toBe(false);
    expect(summary.rows).toBe(0);
    expect(summary.attestations).toEqual([]);
    expect(parsePrivacyAuditRows("")).toEqual({ rows: [], malformedLines: 0 });
  });
});
