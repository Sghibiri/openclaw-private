// Audit row types shared by the OpenClaw Private plugins.
/** Metadata-only privacy audit row. Never carries prompts, keys, bodies or page content. */
export type PrivacyAuditEvent =
  | {
      kind: "attestation";
      provider: string;
      ok: boolean;
      enclaveHost?: string;
      measurement?: string;
      releaseDigest?: string;
      verifierVersion?: string;
      /** The vendor rotated its manifest of reference values since the last pin. */
      manifestRotated?: boolean;
      error?: string;
    }
  | { kind: "egress_blocked"; host: string; source: string }
  | {
      kind: "action";
      tool: string;
      intent: string;
      agentId: string;
      host: string;
      command?: string;
      file?: string;
      mcpServer?: string;
      mcpTool?: string;
      outcome: "allowed" | "refused" | "approval_required" | "human_has_control";
      rule: string | null;
      source: string;
      mode: string;
    }
  | { kind: "boundary_crossing"; from: string; to: string; bytes: number; mode: string }
  | {
      kind: "control";
      agentId: string;
      event: "help_requested" | "secret_requested" | "taken" | "released";
      by: "agent" | "operator";
    }
  | {
      kind: "skill";
      /** approved/revoked by the operator; refused at the run gate; changed on disk (OpenClaw event). */
      action: "approved" | "revoked" | "refused" | "changed";
      name: string;
      /** Where the skill lives (workspace, managed, workshop, ...) or what changed it. */
      source: string;
      fingerprint?: string;
      agentId?: string;
      /** Security check verdict at approval time. */
      verdict?: "green" | "amber" | "red";
      /** The owner's reason for approving a RED verdict (at most 200 characters). */
      riskReason?: string;
    }
  | {
      kind: "validation";
      ok: boolean;
      issues: number;
      mode: "standard" | "private";
      residency: "any" | "eu";
      /** Effective private egress allowlist (private mode only). */
      egressAllow?: string[];
    };

export type PrivacyAuditRow = PrivacyAuditEvent & { at: string; schema: 1 };

export type PrivacyConfigIssue = {
  path: string;
  message: string;
};

/** Result of one attestation attempt, as recorded in the privacy audit log. */
export type AttestationRecord = {
  provider: string;
  ok: boolean;
  /** ISO-8601 time of the attempt. */
  at: string;
  enclaveHost?: string;
  /** Verified code or enclave measurement fingerprint. */
  measurement?: string;
  releaseDigest?: string;
  verifierVersion?: string;
  error?: string;
};
