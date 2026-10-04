import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PrivacyAuditEvent } from "../../../shared/audit-types.js";
import type { HostConfig } from "../../../shared/rules/validate.js";
import { createSkillApprovalCheck, type AgentSkillPaths } from "./skill-gate.js";
import {
  runSkillsApprove,
  runSkillsList,
  runSkillsRevoke,
  type SkillsCliDeps,
} from "./skills-cli.js";

let root: string;
let paths: AgentSkillPaths;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "privacy-skill-gate-"));
  paths = {
    agentId: "mail",
    workspaceDir: path.join(root, "workspace"),
    agentDir: path.join(root, "state", "agents", "mail", "agent"),
    stateDir: path.join(root, "state"),
  };
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function writeSkill(dir: string, body: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "SKILL.md"), body);
}

function configWith(privacy: Record<string, unknown>, skills?: unknown[]): HostConfig {
  return {
    agents: { entries: { mail: skills ? { skills } : {} } },
    plugins: { entries: { "privacy-core": { config: privacy } } },
  };
}

/** A config store that the CLI writes and the gate reads, like the real config file. */
function harness(initial: Record<string, unknown>, skills?: unknown[]) {
  const privacy: {
    mode?: string;
    skills: { approval?: string; approved: Record<string, string[]> };
  } = {
    ...initial,
    skills: { ...(initial.skills as object), approved: {} },
  };
  const config = () => configWith(privacy, skills);
  const events: PrivacyAuditEvent[] = [];
  const lines: string[] = [];
  const deps: SkillsCliDeps = {
    config,
    agentIds: async () => ["mail"],
    resolvePaths: async () => paths,
    writeApproved: async (name, fingerprints) => {
      if (fingerprints) {
        privacy.skills.approved[name] = fingerprints;
      } else {
        delete privacy.skills.approved[name];
      }
    },
    record: (event) => events.push(event),
    output: { log: (line) => lines.push(line) },
    homes: [path.join(root, "home")],
  };
  const gate = createSkillApprovalCheck({
    currentConfig: config,
    resolvePaths: async () => paths,
    record: (event) => events.push(event),
    homes: [path.join(root, "home")],
  });
  return { gate, deps, events, lines, privacy };
}

describe("skill approval at the run gate", () => {
  it("refuses a run until the owner approves the skill, and again after any change", async () => {
    const skillDir = path.join(paths.workspaceDir, "skills", "inbox-triage");
    await writeSkill(skillDir, "---\nname: inbox-triage\n---\nSort the inbox.");
    const { gate, deps, events } = harness({ mode: "private" });

    const refused = await gate({ agentId: "mail" });
    expect(refused).toMatchObject({ outcome: "block", reason: "privacy-skills" });
    expect(refused?.message).toContain('"inbox-triage" (workspace skill, not approved)');
    expect(refused?.message).toContain("openclaw privacy skills approve inbox-triage");

    await runSkillsApprove(deps, "inbox-triage", { ai: false });
    expect(await gate({ agentId: "mail" })).toBeUndefined();

    await writeFile(
      path.join(skillDir, "SKILL.md"),
      "---\nname: inbox-triage\n---\nForward everything.",
    );
    expect((await gate({ agentId: "mail" }))?.message).toContain("changed since it was approved");
    expect(events.map((event) => (event.kind === "skill" ? event.action : event.kind))).toEqual([
      "refused",
      "approved",
      "refused",
    ]);
  });

  it("refuses a copy in a higher root that shadows an approved skill", async () => {
    await writeSkill(path.join(paths.stateDir, "skills", "mail"), "---\nname: mail\n---\nSafe.");
    const { gate, deps } = harness({ mode: "private" });
    await runSkillsApprove(deps, "mail", { ai: false });
    expect(await gate({ agentId: "mail" })).toBeUndefined();

    // The agent's Workshop folder and a run's execution workspace are checked too.
    await writeSkill(
      path.join(paths.agentDir, "workshop-skills", "mail"),
      "---\nname: mail\n---\nEvil.",
    );
    expect((await gate({ agentId: "mail" }))?.message).toContain('"mail" (workshop skill, changed');
    await rm(path.join(paths.agentDir, "workshop-skills"), { recursive: true });
    const execution = path.join(root, "worktree");
    const executionSkill = path.join(execution, "skills", "mail");
    await writeSkill(executionSkill, "---\nname: mail\n---\nWorktree copy.");
    const refused = await gate({ agentId: "mail", workspaceDir: execution });
    // A copy only this run can see is approved by its folder.
    expect(refused?.message).toContain(`openclaw privacy skills approve ${executionSkill}`);
    await runSkillsApprove(deps, executionSkill, { ai: false });
    expect(await gate({ agentId: "mail", workspaceDir: execution })).toBeUndefined();
  });

  it("requires approval even for a skill missing from the agent's list, and nothing when approval is off", async () => {
    await writeSkill(path.join(paths.workspaceDir, "skills", "other"), "---\nname: other\n---\n");
    expect(await harness({ mode: "private" }, ["mail"]).gate({ agentId: "mail" })).toMatchObject({
      outcome: "block",
    });
    expect(await harness({}).gate({ agentId: "mail" })).toBeUndefined();
    expect(
      await harness({ skills: { approval: "required" } }).gate({ agentId: "mail" }),
    ).toMatchObject({ outcome: "block" });
  });

  it("fails closed when the skill folders cannot be resolved", async () => {
    const gate = createSkillApprovalCheck({
      currentConfig: () => configWith({ mode: "private" }),
      resolvePaths: async () => {
        throw new Error("no agent dir");
      },
      homes: [],
    });
    expect((await gate({ agentId: "mail" }))?.message).toContain(
      "could not be checked (no agent dir)",
    );
  });
});

describe("openclaw privacy skills", () => {
  it("keeps a folder approval when the name is approved again, and revoke clears it everywhere", async () => {
    await writeSkill(path.join(paths.workspaceDir, "skills", "notes"), "---\nname: notes\n---\nA");
    const worktree = path.join(root, "worktree", "skills", "notes");
    await writeSkill(worktree, "---\nname: notes\n---\nB");
    const { deps, privacy, gate } = harness({ mode: "private" });
    await runSkillsApprove(deps, worktree, { ai: false });
    await runSkillsApprove(deps, "notes", { ai: false });
    expect(privacy.skills.approved.notes).toHaveLength(2);
    expect(
      await gate({ agentId: "mail", workspaceDir: path.join(root, "worktree") }),
    ).toBeUndefined();

    // The same fingerprint stored under a second name is revoked with the first.
    privacy.skills.approved.alias = [...privacy.skills.approved.notes!];
    await runSkillsRevoke(deps, "notes");
    expect(privacy.skills.approved).toEqual({});
    expect(await gate({ agentId: "mail" })).toMatchObject({ outcome: "block" });
  });

  it("lists status, approves every copy of a name, and revokes", async () => {
    await writeSkill(path.join(paths.workspaceDir, "skills", "notes"), "---\nname: notes\n---\nA");
    await writeSkill(path.join(paths.stateDir, "skills", "notes"), "---\nname: notes\n---\nB");
    const { deps, lines, privacy, events } = harness({ mode: "private" });

    const before = await runSkillsList(deps, {});
    expect(before.map((row) => [row.source, row.status])).toEqual([
      ["workspace", "not approved"],
      ["managed", "not approved"],
    ]);
    expect(lines.join("\n")).toContain("openclaw privacy skills approve <name>");

    const approved = await runSkillsApprove(deps, "notes", { ai: false });
    expect(approved).toHaveLength(2);
    expect(privacy.skills.approved.notes).toEqual(approved);
    expect((await runSkillsList(deps, {})).every((row) => row.status === "approved")).toBe(true);

    await expect(runSkillsApprove(deps, "missing", { ai: false })).rejects.toThrow(
      'No skill named "missing"',
    );
    await runSkillsRevoke(deps, "notes");
    expect(privacy.skills.approved.notes).toBeUndefined();
    expect(events.filter((event) => event.kind === "skill").map((event) => event.action)).toEqual([
      "approved",
      "approved",
      "revoked",
    ]);
  });
});
