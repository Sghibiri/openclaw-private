// Read-only summary of the privacy audit JSONL for `openclaw privacy status`.
// Rows are metadata only, so the summary is too: no prompts, keys or bodies.
import { existsSync, readFileSync } from "node:fs";
import type { PrivacyAuditRow } from "../../../shared/audit-types.js";
import { resolvePrivacyAuditLogPath } from "../../../shared/audit.js";

export type PrivacyAttestationStatus = {
  provider: string;
  ok: boolean;
  at: string;
  enclaveHost?: string;
  measurement?: string;
  releaseDigest?: string;
  verifierVersion?: string;
  manifestRotated?: boolean;
  error?: string;
};

export type PrivacyAuditSummary = {
  file: string;
  exists: boolean;
  /** Rows the reader could parse; malformed lines are counted, not thrown. */
  rows: number;
  malformedLines: number;
  since: string;
  /** Last boot validation decision, if any. */
  lastValidation?: Extract<PrivacyAuditRow, { kind: "validation" }>;
  /** Latest attestation outcome per provider. */
  attestations: PrivacyAttestationStatus[];
  window: {
    egressBlocked: { total: number; byHost: Array<{ host: string; count: number }> };
    actions: Record<"allowed" | "refused" | "approval_required" | "human_has_control", number>;
    boundaryCrossings: { total: number; bytes: number };
    attestationFailures: number;
    control: Record<"help_requested" | "secret_requested" | "taken" | "released", number>;
  };
};

const TOP_HOSTS = 10;

export function parsePrivacyAuditRows(text: string): {
  rows: PrivacyAuditRow[];
  malformedLines: number;
} {
  const rows: PrivacyAuditRow[] = [];
  let malformedLines = 0;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (
        parsed &&
        typeof parsed === "object" &&
        typeof (parsed as { kind?: unknown }).kind === "string" &&
        typeof (parsed as { at?: unknown }).at === "string"
      ) {
        rows.push(parsed as PrivacyAuditRow);
      } else {
        malformedLines += 1;
      }
    } catch {
      malformedLines += 1;
    }
  }
  return { rows, malformedLines };
}

export function summarizePrivacyAuditRows(params: {
  rows: PrivacyAuditRow[];
  since: Date;
}): Omit<PrivacyAuditSummary, "file" | "exists" | "malformedLines"> {
  const sinceMs = params.since.getTime();
  const latestAttestation = new Map<string, PrivacyAttestationStatus>();
  const blockedByHost = new Map<string, number>();
  const actions = { allowed: 0, refused: 0, approval_required: 0, human_has_control: 0 };
  let lastValidation: PrivacyAuditSummary["lastValidation"];
  let crossings = 0;
  let crossingBytes = 0;
  let attestationFailures = 0;
  const control = { help_requested: 0, secret_requested: 0, taken: 0, released: 0 };
  for (const row of params.rows) {
    if (row.kind === "validation") {
      lastValidation = row;
      continue;
    }
    if (row.kind === "attestation") {
      const { kind: _kind, schema: _schema, ...rest } = row;
      latestAttestation.set(row.provider, rest);
    }
    const atMs = Date.parse(row.at);
    if (!Number.isFinite(atMs) || atMs < sinceMs) {
      continue;
    }
    switch (row.kind) {
      case "attestation":
        if (!row.ok) {
          attestationFailures += 1;
        }
        break;
      case "egress_blocked":
        blockedByHost.set(row.host, (blockedByHost.get(row.host) ?? 0) + 1);
        break;
      case "action":
        actions[row.outcome] += 1;
        break;
      case "boundary_crossing":
        crossings += 1;
        crossingBytes += row.bytes;
        break;
      case "control":
        control[row.event] += 1;
        break;
      default:
        break;
    }
  }
  const byHost = [...blockedByHost.entries()]
    .map(([host, count]) => ({ host, count }))
    .toSorted((a, b) => b.count - a.count || a.host.localeCompare(b.host))
    .slice(0, TOP_HOSTS);
  return {
    rows: params.rows.length,
    since: params.since.toISOString(),
    ...(lastValidation ? { lastValidation } : {}),
    attestations: [...latestAttestation.values()].toSorted((a, b) =>
      a.provider.localeCompare(b.provider),
    ),
    window: {
      egressBlocked: {
        total: [...blockedByHost.values()].reduce((sum, count) => sum + count, 0),
        byHost,
      },
      actions,
      boundaryCrossings: { total: crossings, bytes: crossingBytes },
      attestationFailures,
      control,
    },
  };
}

/** Summarize the audit log on disk. A missing file is a valid, empty summary. */
export function summarizePrivacyAuditLog(params: {
  since: Date;
  env?: NodeJS.ProcessEnv;
  file?: string;
}): PrivacyAuditSummary {
  const file = params.file ?? resolvePrivacyAuditLogPath(params.env);
  if (!existsSync(file)) {
    return {
      file,
      exists: false,
      malformedLines: 0,
      ...summarizePrivacyAuditRows({ rows: [], since: params.since }),
    };
  }
  const { rows, malformedLines } = parsePrivacyAuditRows(readFileSync(file, "utf8"));
  return {
    file,
    exists: true,
    malformedLines,
    ...summarizePrivacyAuditRows({ rows, since: params.since }),
  };
}
