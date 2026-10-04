import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  recordPrivacyAuditEvent,
  resolvePrivacyAuditLogPath,
  setPrivacyAuditSinkForTest,
} from "./audit.js";

describe("privacy audit log", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("appends metadata-only JSONL rows under the state dir with private permissions", () => {
    const stateDir = mkdtempSync(path.join(os.tmpdir(), "openclaw-privacy-audit-"));
    dirs.push(stateDir);
    const env = { OPENCLAW_STATE_DIR: stateDir, HOME: stateDir };
    recordPrivacyAuditEvent(
      { kind: "egress_blocked", host: "api.openai.com", source: "web_fetch" },
      { env },
    );
    recordPrivacyAuditEvent(
      { kind: "attestation", provider: "tinfoil", ok: true, measurement: "abc" },
      { env },
    );
    const file = resolvePrivacyAuditLogPath(env);
    expect(file).toBe(path.join(stateDir, "logs", "privacy-audit.jsonl"));
    const rows = readFileSync(file, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ kind: "egress_blocked", host: "api.openai.com", schema: 1 });
    expect(rows[1]).toMatchObject({ kind: "attestation", provider: "tinfoil", ok: true });
    expect(typeof rows[0].at).toBe("string");
    if (process.platform !== "win32") {
      expect(statSync(file).mode & 0o777).toBe(0o600);
    }
  });

  it("routes rows to a test sink when one is installed", () => {
    const captured: unknown[] = [];
    const restore = setPrivacyAuditSinkForTest((row) => captured.push(row));
    try {
      recordPrivacyAuditEvent({
        kind: "validation",
        ok: false,
        issues: 3,
        mode: "private",
        residency: "any",
      });
    } finally {
      restore();
    }
    expect(captured).toEqual([
      expect.objectContaining({ kind: "validation", ok: false, issues: 3 }),
    ]);
  });
});
