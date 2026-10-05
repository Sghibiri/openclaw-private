// `openclaw privacy status`: the privacy posture of this install, from the
// config and the metadata-only audit log. Read-only; never prints content.
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { recordPrivacyAuditEvent } from "../../../shared/audit.js";
import { resolvePrivacySettings, type PrivacySettings } from "../../../shared/rules/settings.js";
import { authoredConfig } from "../../../shared/rules/source-config.js";
import {
  resolveEgressAllowlist,
  validatePrivacyConfig,
  type HostConfig,
  type PrivacyConfigIssue,
} from "../../../shared/rules/validate.js";
import { summarizePrivacyAuditLog, type PrivacyAuditSummary } from "./audit-summary.js";
import { registerPrivacyControlCli } from "./control-cli.js";
import { registerMailCli } from "./mail/mail-cli.js";
import { registerPrivacyMemoryCli } from "./memory-cli-register.js";
import { resolveActionPolicy } from "./policy.js";
import { registerPrivacySetupCli } from "./setup/cli.js";
import { registerPrivacySkillsCli } from "./skills-cli.js";
import { PACK_VERSION } from "./version.js";

type CliProgram = Parameters<Parameters<OpenClawPluginApi["registerCli"]>[0]>[0]["program"];

export type PrivacyStatusReport = {
  mode: "standard" | "private";
  residency: "any" | "eu";
  operatorProviderRegions: Record<string, string>;
  extraEgressAllow: string[];
  /** Hosts the egress proxy lets through right now (private mode). */
  egressAllowlist: string[];
  /** Problems that make the run gate refuse every agent run. */
  issues: PrivacyConfigIssue[];
  boundary: { mode: string; maxChars: number };
  policy: { mode: string; deny: number; approve: number; allow: number; source: string };
  /** `required`: runs are refused while a skill folder an agent loads is not approved. */
  skillApproval: "required" | "off";
  sandbox: "required" | "off";
  /** The connected mailbox, if any (no secrets). */
  mail?: { provider: string; address: string; calendar: boolean };
  audit: PrivacyAuditSummary;
};

export const DEFAULT_STATUS_WINDOW = "24h";

const DURATION_UNITS_MS: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000 };

/** Parse a status window such as "30m", "24h" or "7d". */
export function parseStatusWindowMs(raw: string): number {
  const match = /^(\d{1,6})\s*([mhd])$/u.exec(raw.trim().toLowerCase());
  if (!match) {
    throw new Error(
      `invalid --since "${raw}": use a number followed by m, h or d, for example 24h or 7d`,
    );
  }
  return Number(match[1]) * DURATION_UNITS_MS[match[2] as string]!;
}

export function buildPrivacyStatusReport(params: {
  config: HostConfig;
  settings: PrivacySettings;
  since: Date;
  env?: NodeJS.ProcessEnv;
  auditFile?: string;
}): PrivacyStatusReport {
  const { settings } = params;
  const privateMode = settings.mode === "private";
  const policy = resolveActionPolicy({ privateMode, configured: settings.policy });
  const operatorProviderRegions: Record<string, string> = {};
  for (const [id, declared] of Object.entries(settings.providers)) {
    operatorProviderRegions[id] = declared.region;
  }
  return {
    mode: settings.mode,
    residency: settings.residency,
    operatorProviderRegions,
    extraEgressAllow: [...settings.egress.allow],
    egressAllowlist: privateMode ? resolveEgressAllowlist(params.config, settings) : [],
    issues: validatePrivacyConfig(params.config, settings),
    boundary: { ...settings.boundary },
    policy: {
      mode: policy.mode,
      deny: policy.deny.length,
      approve: policy.approve.length,
      allow: policy.allow.length,
      source: settings.policy ? "config" : privateMode ? "private default" : "standard default",
    },
    skillApproval: settings.skills.approval,
    sandbox: settings.sandbox,
    ...(settings.mail
      ? {
          mail: {
            provider: settings.mail.provider,
            address: settings.mail.address,
            calendar: settings.mail.calendarUrl !== undefined,
          },
        }
      : {}),
    audit: summarizePrivacyAuditLog({
      since: params.since,
      env: params.env,
      file: params.auditFile,
    }),
  };
}

function shortDigest(value: string | undefined): string {
  if (!value) {
    return "-";
  }
  return value.length > 16 ? `${value.slice(0, 16)}…` : value;
}

export function formatPrivacyStatusReport(report: PrivacyStatusReport, window: string): string {
  const lines: string[] = [];
  const { audit } = report;
  lines.push(`Privacy mode: ${report.mode}`);
  lines.push(`Residency: ${report.residency}`);
  const operator = Object.entries(report.operatorProviderRegions);
  if (operator.length > 0) {
    lines.push(
      `Operator-declared provider regions: ${operator
        .map(([id, region]) => `${id}=${region}`)
        .join(", ")}`,
    );
  }
  if (report.mode === "private") {
    lines.push(`Boundary: ${report.boundary.mode}, max ${report.boundary.maxChars} chars`);
    lines.push(
      report.sandbox === "off"
        ? "Sandbox: lite mode (no Docker; private agents have no shell, file or browser tools)"
        : "Sandbox: required (private agents run their tools in a container)",
    );
    lines.push(
      report.mail
        ? `Mail: ${report.mail.address} (${report.mail.provider}), read-only; calendar ${report.mail.calendar ? "connected" : "not connected"}`
        : "Mail: not connected (openclaw privacy mail connect)",
    );
  }
  lines.push(
    `Action policy: ${report.policy.mode} (${report.policy.source}; deny ${report.policy.deny}, approve ${report.policy.approve}, allow ${report.policy.allow})`,
  );
  lines.push(
    report.skillApproval === "required"
      ? "Skill approval: required (openclaw privacy skills list shows what waits for approval)"
      : "Skill approval: off",
  );
  if (report.issues.length > 0) {
    lines.push("");
    lines.push(
      `REFUSING AGENT RUNS: ${report.issues.length} problem${report.issues.length === 1 ? "" : "s"} in the privacy config:`,
    );
    for (const issue of report.issues) {
      lines.push(`  - ${issue.path}: ${issue.message}`);
    }
  } else {
    lines.push("Config: ok, agent runs allowed");
  }
  if (report.mode === "private") {
    lines.push(`Egress allowlist: ${report.egressAllowlist.join(", ") || "(empty)"}`);
  }
  lines.push("");
  if (audit.lastValidation) {
    const validation = audit.lastValidation;
    lines.push(
      `Last gateway start: ${validation.ok ? "ok" : `refused (${validation.issues} issue${validation.issues === 1 ? "" : "s"})`} at ${validation.at} (mode ${validation.mode}, residency ${validation.residency})`,
    );
  } else {
    lines.push(
      "Last gateway start: none recorded (the gateway has not started with a privacy posture yet)",
    );
  }
  if (report.extraEgressAllow.length > 0) {
    lines.push(`Extra egress hosts (egress.allow): ${report.extraEgressAllow.join(", ")}`);
  }
  lines.push("");
  lines.push("Attestations (latest per provider):");
  if (audit.attestations.length === 0) {
    lines.push("  none recorded");
  }
  for (const row of audit.attestations) {
    lines.push(
      `  ${row.provider}: ${row.ok ? "verified" : "FAILED"} at ${row.at}` +
        (row.enclaveHost ? ` host ${row.enclaveHost}` : "") +
        ` measurement ${shortDigest(row.measurement)}` +
        (row.releaseDigest ? ` release ${shortDigest(row.releaseDigest)}` : "") +
        (row.manifestRotated ? " (vendor manifest rotated)" : "") +
        (row.error ? ` error: ${row.error}` : ""),
    );
  }
  lines.push("");
  lines.push(`Last ${window}:`);
  lines.push(`  attestation failures: ${audit.window.attestationFailures}`);
  lines.push(`  egress refusals: ${audit.window.egressBlocked.total}`);
  for (const { host, count } of audit.window.egressBlocked.byHost) {
    lines.push(`    ${host}: ${count}`);
  }
  const actions = audit.window.actions;
  lines.push(
    `  actions: allowed ${actions.allowed}, refused ${actions.refused}, approval required ${actions.approval_required}, human had control ${actions.human_has_control}`,
  );
  lines.push(
    `  boundary crossings: ${audit.window.boundaryCrossings.total} (${audit.window.boundaryCrossings.bytes} bytes left the private gateway)`,
    `  mail: ${audit.window.mail.search} searches, ${audit.window.mail.read} emails read, ${audit.window.mail.calendar} calendar lookups`,
  );
  const control = audit.window.control;
  lines.push(
    `  take-the-wheel: help requested ${control.help_requested}, taken ${control.taken}, released ${control.released}`,
  );
  lines.push("");
  lines.push(
    `Audit log: ${audit.file}${audit.exists ? ` (${audit.rows} rows${audit.malformedLines ? `, ${audit.malformedLines} malformed lines` : ""})` : " (not created yet)"}`,
  );
  return lines.join("\n");
}

export function registerPrivacyCli(program: CliProgram, api: OpenClawPluginApi): void {
  const settings = resolvePrivacySettings(api.pluginConfig);
  const privacy = program
    .command("privacy")
    .description("Inspect the privacy posture of this install and hand control to a person");
  privacy
    .command("status")
    .description("Show privacy mode, config problems, attestations and audit counters")
    .option("--json", "Print the report as JSON")
    .option(
      "--since <duration>",
      `Window for the counters, e.g. 1h, 7d (default ${DEFAULT_STATUS_WINDOW})`,
    )
    .action((options: { json?: boolean; since?: string }) => {
      const window = options.since ?? DEFAULT_STATUS_WINDOW;
      const since = new Date(Date.now() - parseStatusWindowMs(window));
      const report = buildPrivacyStatusReport({
        config: authoredConfig(api.config),
        settings,
        since,
      });
      if (options.json) {
        process.stdout.write(`${JSON.stringify({ window, ...report }, null, 2)}\n`);
        return;
      }
      process.stdout.write(`${formatPrivacyStatusReport(report, window)}\n`);
    });
  registerPrivacyControlCli(privacy);
  registerPrivacySetupCli(privacy, PACK_VERSION);
  registerMailCli(privacy);
  registerPrivacyMemoryCli(privacy, () => api.config);
  registerPrivacySkillsCli(privacy, {
    config: () => authoredConfig(api.config),
    record: (event) => void recordPrivacyAuditEvent(event),
    // The AI review uses this gateway's default model through OpenClaw, so a
    // private gateway reviews skills on its attested or local model.
    complete: async ({ systemPrompt, user }) => {
      const result = await api.runtime.llm.complete({
        messages: [{ role: "user", content: user }],
        systemPrompt,
        purpose: "privacy-core.skill-review",
        maxTokens: 1500,
        temperature: 0,
      });
      return {
        text: result.text,
        model: `${result.provider}/${result.model}`,
        ...(result.stopReason ? { stopReason: result.stopReason } : {}),
      };
    },
  });
}
