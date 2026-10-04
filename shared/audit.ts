// Append-only JSONL privacy audit log under the OpenClaw state dir.
// Rows are metadata only; callers must never place content or credentials in them.
// All three plugins of the pack write here, so `openclaw privacy status` sees
// attestations, egress refusals, actions, crossings and handoffs in one place.
import { appendFileSync, chmodSync, mkdirSync } from "node:fs";
import path from "node:path";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import type { PrivacyAuditEvent, PrivacyAuditRow } from "./audit-types.js";

export type { PrivacyAuditEvent, PrivacyAuditRow } from "./audit-types.js";

const PRIVACY_AUDIT_FILE = "privacy-audit.jsonl";

export function resolvePrivacyAuditLogPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveStateDir(env), "logs", PRIVACY_AUDIT_FILE);
}

let sink: ((row: PrivacyAuditRow) => void) | null = null;

/** Test seam: capture rows instead of writing them. Returns a restore function. */
export function setPrivacyAuditSinkForTest(
  next: ((row: PrivacyAuditRow) => void) | null,
): () => void {
  const previous = sink;
  sink = next;
  return () => {
    sink = previous;
  };
}

export function recordPrivacyAuditEvent(
  event: PrivacyAuditEvent,
  options: { env?: NodeJS.ProcessEnv; file?: boolean } = {},
): PrivacyAuditRow {
  const row: PrivacyAuditRow = { ...event, at: new Date().toISOString(), schema: 1 };
  if (sink) {
    sink(row);
    return row;
  }
  if (options.file === false) {
    return row;
  }
  const file = resolvePrivacyAuditLogPath(options.env);
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  appendFileSync(file, `${JSON.stringify(row)}\n`, { mode: 0o600 });
  try {
    chmodSync(file, 0o600);
  } catch {
    // Filesystems without POSIX modes (some network mounts) keep their defaults.
  }
  return row;
}
