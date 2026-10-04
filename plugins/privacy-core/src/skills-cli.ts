// `openclaw privacy skills list|approve|revoke`: the owner's side of skill
// approval. Approving records the fingerprint of every current copy of a skill
// in privacy-core's config; the run gate refuses runs while any skill folder
// the gateway would load has a fingerprint that is not approved.
import path from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { PrivacyAuditEvent } from "../../../shared/audit-types.js";
import { resolvePrivacySettings } from "../../../shared/rules/settings.js";
import {
  resolveEgressAllowlist,
  validatePrivacyConfig,
  type HostConfig,
} from "../../../shared/rules/validate.js";
import {
  createSkillScanner,
  findUnapprovedSkills,
  type FoundSkill,
  type SkillRefusal,
} from "./skill-approval.js";
import {
  checkSkill,
  formatSkillCheckReport,
  strictestVerdict,
  oneLine,
  type CompleteFn,
  type SkillCheckReport,
} from "./skill-check.js";
import { resolveAgentSkillPaths, rootsForAgentPaths, type AgentSkillPaths } from "./skill-gate.js";

type CliProgram = Parameters<Parameters<OpenClawPluginApi["registerCli"]>[0]>[0]["program"];
type PrivacyCommand = ReturnType<CliProgram["command"]>;

export type SkillsCliDeps = {
  config: () => HostConfig;
  agentIds: (config: HostConfig) => Promise<string[]>;
  resolvePaths: (config: HostConfig, agentId: string) => Promise<AgentSkillPaths>;
  /** Sets (or with `undefined`, removes) the approved fingerprints for one skill name. */
  writeApproved: (name: string, fingerprints: string[] | undefined) => Promise<void>;
  record: (event: PrivacyAuditEvent) => void;
  output: { log: (line: string) => void };
  homes?: string[];
  /** Model call for the AI review; absent means rules only. */
  complete?: CompleteFn;
  /** Asks the owner a question on the terminal; absent or no terminal means no answer. */
  ask?: (question: string) => Promise<string | undefined>;
};

export type SkillRow = FoundSkill & {
  agentIds: string[];
  status: "approved" | "not approved" | "changed" | "unreadable";
};

/** Names that would collide with object internals in the config file. */
const RESERVED_NAMES = new Set(["__proto__", "constructor", "prototype"]);

const STATUS: Record<SkillRefusal["reason"], SkillRow["status"]> = {
  unapproved: "not approved",
  changed: "changed",
  unreadable: "unreadable",
};

async function scanAllAgents(deps: SkillsCliDeps, onlyAgent?: string) {
  const config = deps.config();
  const settings = resolvePrivacySettings(config.plugins?.entries?.["privacy-core"]?.config);
  const scanner = createSkillScanner();
  const rows = new Map<string, SkillRow>();
  const problems: string[] = [];
  const ids = onlyAgent ? [onlyAgent] : await deps.agentIds(config);
  for (const agentId of ids) {
    const paths = await deps.resolvePaths(config, agentId);
    const scan = await scanner.scan(rootsForAgentPaths(config, paths, undefined, deps.homes));
    problems.push(...scan.problems);
    const refused = new Map(
      findUnapprovedSkills(scan.skills, settings.skills.approved).map((refusal) => [
        refusal.skill.dir,
        refusal.reason,
      ]),
    );
    for (const skill of scan.skills) {
      const existing = rows.get(skill.dir);
      if (existing) {
        existing.agentIds.push(agentId);
        continue;
      }
      const reason = refused.get(skill.dir);
      rows.set(skill.dir, {
        ...skill,
        agentIds: [agentId],
        status: reason ? STATUS[reason] : "approved",
      });
    }
  }
  return { settings, rows: [...rows.values()], problems: [...new Set(problems)] };
}

const short = (fingerprint: string | null) =>
  fingerprint ? fingerprint.slice("sha256:".length, "sha256:".length + 12) : "-";

export async function runSkillsList(
  deps: SkillsCliDeps,
  opts: { agent?: string; json?: boolean },
): Promise<SkillRow[]> {
  const { settings, rows, problems } = await scanAllAgents(deps, opts.agent?.trim() || undefined);
  if (opts.json) {
    deps.output.log(
      JSON.stringify({ approval: settings.skills.approval, skills: rows, problems }, null, 2),
    );
    return rows;
  }
  deps.output.log(
    settings.skills.approval === "required"
      ? "Skill approval: required. Runs are refused while any skill below is not approved, changed or unreadable."
      : 'Skill approval: off. Set plugins.entries.privacy-core.config.skills.approval to "required" to turn it on.',
  );
  if (rows.length === 0) {
    deps.output.log("No skills found outside OpenClaw and its plugins.");
  }
  for (const row of rows) {
    deps.output.log(
      oneLine(
        `${row.status.padEnd(13)} ${row.name.padEnd(24)} ${row.source.padEnd(9)} ${short(row.fingerprint)}  ${row.dir}  (agents: ${row.agentIds.join(", ")})${row.problem ? `  ${row.problem}` : ""}`,
      ),
    );
  }
  for (const problem of problems) {
    deps.output.log(oneLine(`Could not scan: ${problem}`));
  }
  if (rows.some((row) => row.status !== "approved")) {
    deps.output.log(
      "Read each folder above, then approve it with: openclaw privacy skills approve <name>",
    );
  }
  return rows;
}

function looksLikePath(target: string): boolean {
  return target.includes("/") || target.includes(path.sep) || target.startsWith(".");
}

type Copies = { name: string; copies: FoundSkill[] };

/** Every copy of a skill by name, or the one skill folder at a path. */
async function resolveCopies(deps: SkillsCliDeps, target: string): Promise<Copies> {
  if (looksLikePath(target)) {
    const dir = path.resolve(target);
    const scan = await createSkillScanner().scan([{ source: "execution", dir }]);
    const copies = scan.skills.filter((skill) => skill.dir === dir);
    if (copies.length === 0) {
      throw new Error(oneLine(`${dir} is not a skill folder (no SKILL.md in it).`));
    }
    return { name: copies[0]!.name, copies };
  }
  const { rows } = await scanAllAgents(deps);
  const copies = rows.filter((row) => row.name === target);
  if (copies.length === 0) {
    throw new Error(
      oneLine(
        `No skill named "${target}" was found in any agent's skill folders. See: openclaw privacy skills list`,
      ),
    );
  }
  return { name: target, copies };
}

export type CheckOptions = { ai?: boolean; json?: boolean };

async function checkCopies(
  deps: SkillsCliDeps,
  { name, copies }: Copies,
  opts: CheckOptions,
): Promise<SkillCheckReport[]> {
  const config = deps.config();
  const settings = resolvePrivacySettings(config.plugins?.entries?.["privacy-core"]?.config);
  const privateMode = settings.mode === "private";
  const egressAllow = privateMode ? resolveEgressAllowlist(config, settings) : undefined;
  // On a private gateway the review must run on its attested or local model,
  // which only holds while the privacy config is safe.
  const unsafe = privateMode && validatePrivacyConfig(config, settings).length > 0;
  const complete =
    opts.ai === false
      ? undefined
      : unsafe
        ? "the privacy config has problems (openclaw privacy status), so no model is used"
        : (deps.complete ?? "no model is available to this command");
  const reports: SkillCheckReport[] = [];
  for (const copy of copies) {
    reports.push(
      await checkSkill({
        name,
        dir: copy.dir,
        ...(egressAllow ? { egressAllow } : {}),
        ...(complete !== undefined ? { complete } : {}),
      }),
    );
  }
  return reports;
}

/** `privacy skills check`: the report alone; approves nothing. */
export async function runSkillsCheck(
  deps: SkillsCliDeps,
  target: string,
  opts: CheckOptions,
): Promise<SkillCheckReport[]> {
  const reports = await checkCopies(deps, await resolveCopies(deps, target), opts);
  deps.output.log(
    opts.json ? JSON.stringify(reports, null, 2) : reports.map(formatSkillCheckReport).join("\n\n"),
  );
  return reports;
}

export type ApproveOptions = CheckOptions & {
  /** Confirms an AMBER verdict without a prompt. */
  yes?: boolean;
  /** Required to approve a RED verdict; recorded in the audit log. */
  acceptRisk?: string;
};

const MAX_RISK_REASON = 200;

/**
 * Approves a skill by name (every copy in every agent's skill folders) or by
 * folder path (that one copy; for a run's own execution workspace), after the
 * security check. AMBER needs a confirmation, RED a typed reason. New
 * fingerprints are added to the name's earlier ones; `revoke` clears them.
 */
export async function runSkillsApprove(
  deps: SkillsCliDeps,
  target: string,
  opts: ApproveOptions = {},
): Promise<string[]> {
  const { name, copies } = await resolveCopies(deps, target);
  if (RESERVED_NAMES.has(name)) {
    throw new Error(
      oneLine(`A skill named "${name}" cannot be approved; rename it in its SKILL.md.`),
    );
  }
  const unreadable = copies.find((copy) => !copy.fingerprint);
  if (unreadable) {
    throw new Error(
      oneLine(
        `"${name}" at ${unreadable.dir} could not be read (${unreadable.problem ?? "unknown"}); nothing was approved.`,
      ),
    );
  }
  const reports = await checkCopies(deps, { name, copies }, opts);
  deps.output.log(reports.map(formatSkillCheckReport).join("\n\n"));
  const verdict = strictestVerdict(...reports.map((report) => report.verdict));
  let reason = opts.acceptRisk?.trim().slice(0, MAX_RISK_REASON);
  if (verdict === "red" && !reason) {
    reason = (
      await deps.ask?.(
        `"${oneLine(name)}" is RED. To approve it anyway, type why you trust it (or press Enter to cancel): `,
      )
    )
      ?.trim()
      .slice(0, MAX_RISK_REASON);
    if (!reason) {
      throw new Error(
        'Not approved: the check found something dangerous. If you are sure, approve with --accept-risk "<why>"; the reason goes into the audit log.',
      );
    }
  }
  if (verdict === "amber" && !opts.yes && !reason) {
    const answer = await deps.ask?.(
      `Approve "${oneLine(name)}" with the warnings above? Type yes to approve: `,
    );
    if (answer?.trim().toLowerCase() !== "yes") {
      throw new Error(
        "Not approved. Read the warnings above; to approve anyway, answer yes or add --yes.",
      );
    }
  }
  // An approval covers exactly the bytes the check read.
  for (const [index, copy] of copies.entries()) {
    if (reports[index]?.fingerprint !== copy.fingerprint) {
      throw new Error(
        `"${oneLine(name)}" at ${oneLine(copy.dir)} changed while it was being checked; nothing was approved.`,
      );
    }
  }
  const approved = approvedOf(deps);
  const earlier = Object.hasOwn(approved, name) ? approved[name]! : [];
  const fingerprints = [
    ...new Set([...earlier, ...copies.map((copy) => copy.fingerprint as string)]),
  ].toSorted();
  await deps.writeApproved(name, fingerprints);
  for (const copy of copies) {
    deps.record({
      kind: "skill",
      action: "approved",
      name,
      source: copy.source,
      fingerprint: copy.fingerprint as string,
      verdict,
      ...(reason ? { riskReason: reason } : {}),
    });
    deps.output.log(
      oneLine(
        `Approved "${name}" (${copy.source}, ${copy.files} files, ${short(copy.fingerprint)}): ${copy.dir}`,
      ),
    );
  }
  deps.output.log("Any later change to these files needs a new approval.");
  return fingerprints;
}

function approvedOf(deps: SkillsCliDeps): Record<string, string[]> {
  return resolvePrivacySettings(deps.config().plugins?.entries?.["privacy-core"]?.config).skills
    .approved;
}

/**
 * Removes every approval of a name. The same fingerprints are removed from any
 * other name too: an approval counts whatever name it is stored under.
 */
export async function runSkillsRevoke(deps: SkillsCliDeps, name: string): Promise<void> {
  const approved = approvedOf(deps);
  if (!Object.hasOwn(approved, name)) {
    deps.output.log(oneLine(`"${name}" has no approval to revoke.`));
    return;
  }
  const revoked = new Set(approved[name]);
  await deps.writeApproved(name, undefined);
  for (const [other, fingerprints] of Object.entries(approved)) {
    if (other !== name && fingerprints.some((fingerprint) => revoked.has(fingerprint))) {
      const kept = fingerprints.filter((fingerprint) => !revoked.has(fingerprint));
      await deps.writeApproved(other, kept.length > 0 ? kept : undefined);
    }
  }
  deps.record({ kind: "skill", action: "revoked", name, source: "operator" });
  deps.output.log(
    `Revoked the approval of "${name}". Runs are refused while it is present, until it is approved again.`,
  );
}

type PluginEntryDraft = { config?: { skills?: { approved?: Record<string, string[]> } } };

/** Writes the approval into the config file through OpenClaw's config writer. */
async function writeApprovedToConfig(
  name: string,
  fingerprints: string[] | undefined,
): Promise<void> {
  const { mutateConfigFile } = await import("openclaw/plugin-sdk/config-mutation");
  await mutateConfigFile({
    mutate: (draft) => {
      const root = draft as {
        plugins?: { entries?: Record<string, PluginEntryDraft | undefined> };
      };
      const plugins = (root.plugins ??= {});
      const entries = (plugins.entries ??= {});
      const entry = (entries["privacy-core"] ??= {});
      const config = (entry.config ??= {});
      const skills = (config.skills ??= {});
      const approved = (skills.approved ??= {});
      if (fingerprints) {
        approved[name] = fingerprints;
      } else {
        delete approved[name];
      }
    },
  });
}

/** A question on the terminal; undefined when there is no terminal to ask on. */
async function askOnTerminal(question: string): Promise<string | undefined> {
  if (!process.stdin.isTTY) {
    return undefined;
  }
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

export function registerPrivacySkillsCli(
  privacy: PrivacyCommand,
  options: {
    config: () => HostConfig;
    record: (event: PrivacyAuditEvent) => void;
    complete?: CompleteFn;
  },
): void {
  const deps = (): SkillsCliDeps => ({
    config: options.config,
    agentIds: async (config) => {
      const { listAgentIds } = await import("openclaw/plugin-sdk/agent-scope-runtime");
      return listAgentIds(config as Parameters<typeof listAgentIds>[0]);
    },
    resolvePaths: resolveAgentSkillPaths,
    writeApproved: writeApprovedToConfig,
    record: options.record,
    output: console,
    ...(options.complete ? { complete: options.complete } : {}),
    ask: askOnTerminal,
  });
  const fail = (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  };
  const skills = privacy
    .command("skills")
    .description("Check, review and approve the skills agents can use (approval by fingerprint)");
  skills
    .command("list")
    .description("List every skill outside OpenClaw and its plugins, with its approval status")
    .option("--agent <id>", "Only this agent")
    .option("--json", "Print JSON")
    .action(async (opts: { agent?: string; json?: boolean }) => {
      await runSkillsList(deps(), opts).catch(fail);
    });
  skills
    .command("check")
    .description("Security check of a skill, in plain words; approves nothing")
    .argument("<name-or-folder>", "Skill name, or the path of a skill folder you want to add")
    .option("--no-ai", "Rules only; skip the AI review")
    .option("--json", "Print JSON")
    .action(async (target: string, opts: { ai?: boolean; json?: boolean }) => {
      await runSkillsCheck(deps(), target, opts).catch(fail);
    });
  skills
    .command("approve")
    .description(
      "Check a skill, then approve it as it is on disk now; any later change needs a new approval",
    )
    .argument(
      "<name-or-folder>",
      "Skill name from `privacy skills list`, or the path of one skill folder",
    )
    .option("--no-ai", "Rules only; skip the AI review")
    .option("--yes", "Approve an AMBER result without the question")
    .option(
      "--accept-risk <reason>",
      "Approve whatever the verdict; the reason is kept in the audit log",
    )
    .action(async (target: string, opts: { ai?: boolean; yes?: boolean; acceptRisk?: string }) => {
      await runSkillsApprove(deps(), target, opts).catch(fail);
    });
  skills
    .command("revoke")
    .description("Remove a skill's approval")
    .argument("<name>", "Skill name")
    .action(async (name: string) => {
      await runSkillsRevoke(deps(), name).catch(fail);
    });
}
