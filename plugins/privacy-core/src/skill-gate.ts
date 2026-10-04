// Run-gate half of skill approval: before an agent run, every skill folder the
// agent's gateway would load must be approved as it is on disk now. Otherwise
// the run is refused with the skill names and the command that approves them.
import type { PrivacyAuditEvent } from "../../../shared/audit-types.js";
import { resolvePrivacySettings } from "../../../shared/rules/settings.js";
import type { HostConfig } from "../../../shared/rules/validate.js";
import type { RunGateContext, RunGateDecision } from "./run-gate.js";
import {
  createSkillScanner,
  describeSkillRefusal,
  findUnapprovedSkills,
  loadsPersonalSkills,
  skillHomes,
  skillRootsForAgent,
  type SkillRefusal,
  type SkillRoot,
} from "./skill-approval.js";

export type AgentSkillPaths = {
  agentId: string;
  workspaceDir: string;
  agentDir: string;
  stateDir: string;
};

/** Resolves an agent's directories through OpenClaw's own resolvers. */
export async function resolveAgentSkillPaths(
  config: HostConfig,
  agentId: string | undefined,
): Promise<AgentSkillPaths> {
  const [
    { resolveAgentDir, resolveDefaultAgentId },
    { resolveAgentWorkspaceDir },
    { resolveStateDir },
  ] = await Promise.all([
    import("openclaw/plugin-sdk/agent-scope-runtime"),
    import("openclaw/plugin-sdk/memory-core-host-engine-foundation"),
    import("openclaw/plugin-sdk/state-paths"),
  ]);
  // HostConfig is the slice of OpenClawConfig these rules read.
  const cfg = config as Parameters<typeof resolveAgentDir>[0];
  const id = agentId?.trim() || resolveDefaultAgentId(cfg);
  return {
    agentId: id,
    workspaceDir: resolveAgentWorkspaceDir(cfg, id),
    agentDir: resolveAgentDir(cfg, id),
    stateDir: resolveStateDir(),
  };
}

export function rootsForAgentPaths(
  config: HostConfig,
  paths: AgentSkillPaths,
  executionWorkspaceDir?: string,
  homes: string[] = skillHomes(),
): SkillRoot[] {
  return skillRootsForAgent({
    workspaceDir: paths.workspaceDir,
    ...(executionWorkspaceDir ? { executionWorkspaceDir } : {}),
    agentDir: paths.agentDir,
    stateDir: paths.stateDir,
    extraDirs: config.skills?.load?.extraDirs ?? [],
    homes,
    includePersonal: loadsPersonalSkills(paths.stateDir, homes),
  });
}

/** What to pass to `privacy skills approve`: the folder for a copy only this run can see. */
export function approveTarget(refusal: SkillRefusal): string {
  return refusal.skill.source === "execution" ? refusal.skill.dir : refusal.skill.name;
}

function block(message: string): RunGateDecision {
  return { outcome: "block", reason: "privacy-skills", message };
}

export function createSkillApprovalCheck(options: {
  currentConfig: () => HostConfig;
  resolvePaths?: (config: HostConfig, agentId: string | undefined) => Promise<AgentSkillPaths>;
  homes?: string[];
  record?: (event: PrivacyAuditEvent) => void;
  log?: (message: string) => void;
}): (ctx: RunGateContext | undefined) => Promise<RunGateDecision> {
  const scanner = createSkillScanner();
  const resolvePaths = options.resolvePaths ?? resolveAgentSkillPaths;
  // Refusals are recorded once per change, not on every run.
  let lastRefused = "";
  return async (ctx) => {
    const config = options.currentConfig();
    const settings = resolvePrivacySettings(config.plugins?.entries?.["privacy-core"]?.config);
    if (settings.skills.approval !== "required") {
      return undefined;
    }
    try {
      const paths = await resolvePaths(config, ctx?.agentId);
      const scan = await scanner.scan(
        rootsForAgentPaths(config, paths, ctx?.workspaceDir, options.homes),
      );
      if (scan.problems.length > 0) {
        return block(
          `Skills could not be checked (${scan.problems.join("; ")}), so this run is refused.`,
        );
      }
      const refusals = findUnapprovedSkills(scan.skills, settings.skills.approved);
      if (refusals.length === 0) {
        lastRefused = "";
        return undefined;
      }
      const key = refusals
        .map(
          (refusal) => `${refusal.skill.dir}:${refusal.skill.fingerprint ?? refusal.skill.problem}`,
        )
        .join("\n");
      if (key !== lastRefused) {
        lastRefused = key;
        for (const refusal of refusals) {
          options.record?.({
            kind: "skill",
            action: "refused",
            name: refusal.skill.name,
            source: refusal.skill.source,
            agentId: paths.agentId,
            ...(refusal.skill.fingerprint ? { fingerprint: refusal.skill.fingerprint } : {}),
          });
          options.log?.(
            `agent "${paths.agentId}": skill ${describeSkillRefusal(refusal)} at ${refusal.skill.dir}`,
          );
        }
      }
      const shown = refusals.slice(0, 3).map(describeSkillRefusal).join(", ");
      const more = refusals.length > 3 ? ` and ${refusals.length - 3} more` : "";
      const first = refusals[0];
      return block(
        `This agent's gateway has skills the owner has not approved: ${shown}${more}. ` +
          `Runs are refused until the owner reviews them (openclaw privacy skills list) and runs: ` +
          `openclaw privacy skills approve ${first ? approveTarget(first) : "<name>"}`,
      );
    } catch (error) {
      return block(
        `Skills could not be checked (${error instanceof Error ? error.message : String(error)}), so this run is refused.`,
      );
    }
  };
}
