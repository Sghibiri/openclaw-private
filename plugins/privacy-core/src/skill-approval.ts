// Skill approval: every skill folder a gateway would load must match a
// fingerprint the owner approved with `openclaw privacy skills approve`.
//
// This module does not copy OpenClaw's naming, precedence or visibility rules
// (frontmatter parsing, skill keys, agent allowlists, session overrides). Any
// copy of those rules can drift from OpenClaw and let a skill through. Instead
// every skill folder in every non-shipped root needs an approved fingerprint,
// and the fingerprint covers what OpenClaw derives a skill's identity from:
// the folder name and every file. Skills shipped with OpenClaw or an installed
// plugin are trusted with that code and are not fingerprinted.
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

export type SkillSource =
  | "workspace"
  | "project"
  | "execution"
  | "personal"
  | "managed"
  | "workshop"
  | "library"
  | "extra";

export type SkillRoot = { source: SkillSource; dir: string };

export type FoundSkill = {
  /** Display label and approval key; enforcement does not depend on it. */
  name: string;
  source: SkillSource;
  dir: string;
  /** `sha256:<hex>` over the folder name and every file; null when it could not be read. */
  fingerprint: string | null;
  files: number;
  bytes: number;
  problem?: string;
};

export type SkillScan = {
  skills: FoundSkill[];
  /** Roots that could not be fully scanned. Any entry means approval cannot be proven. */
  problems: string[];
};

export type SkillRefusal = {
  skill: FoundSkill;
  reason: "unapproved" | "changed" | "unreadable";
};

const MAX_DIRS_PER_ROOT = 20_000;
const MAX_SKILL_FILES = 1000;
const MAX_SKILL_BYTES = 64 * 1024 * 1024;
/** OpenClaw reads at most this much of SKILL.md. */
const MAX_SKILL_MD_BYTES = 256 * 1024;
/** Folders inside one skill; bounds a symlink maze that holds no files. */
const MAX_SKILL_DIRS = 1000;

/** Missing paths are normal; any other error means a folder could not be checked. */
function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Reads a regular file. Opened non-blocking and type-checked on the open
 * handle, so a FIFO or device swapped in after discovery cannot hang the read.
 */
export async function readRegularFile(file: string, maxBytes?: number): Promise<Buffer> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile()) {
      throw new Error(`${path.basename(file)} is not a regular file`);
    }
    if (maxBytes === undefined) {
      return await handle.readFile();
    }
    const buffer = Buffer.alloc(Math.min(maxBytes, info.size));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/**
 * Whether OpenClaw reads ~/.agents/skills: only for the default state dir, that
 * is OPENCLAW_STATE_DIR unset or pointing at ~/.openclaw (paths:isDefaultStateDir).
 */
export function loadsPersonalSkills(
  stateDir: string,
  homes: string[],
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return (
    !env.OPENCLAW_STATE_DIR?.trim() ||
    homes.some((home) => path.resolve(stateDir) === path.join(home, ".openclaw"))
  );
}

/**
 * Home folders OpenClaw may treat as `~`: the OS home and OPENCLAW_HOME. Both
 * are scanned; an extra root costs nothing in safety.
 */
export function skillHomes(env: NodeJS.ProcessEnv = process.env): string[] {
  const homes = [homedir()];
  const configured = env.OPENCLAW_HOME?.trim();
  if (configured) {
    homes.push(path.resolve(configured));
  }
  return [...new Set(homes)];
}

/** The non-shipped roots OpenClaw loads skills from for one agent (2026.9.x layout). */
export function skillRootsForAgent(params: {
  workspaceDir: string;
  /** A run's execution workspace, when it differs from the agent's. */
  executionWorkspaceDir?: string;
  agentDir: string;
  stateDir: string;
  extraDirs?: string[];
  homes: string[];
  includePersonal: boolean;
}): SkillRoot[] {
  const roots: SkillRoot[] = [
    { source: "workspace", dir: path.join(params.workspaceDir, "skills") },
    { source: "project", dir: path.join(params.workspaceDir, ".agents", "skills") },
  ];
  if (params.executionWorkspaceDir) {
    roots.push(
      { source: "execution", dir: path.join(params.executionWorkspaceDir, "skills") },
      { source: "execution", dir: path.join(params.executionWorkspaceDir, ".agents", "skills") },
    );
  }
  if (params.includePersonal) {
    for (const home of params.homes) {
      roots.push({ source: "personal", dir: path.join(home, ".agents", "skills") });
    }
  }
  roots.push(
    { source: "managed", dir: path.join(params.stateDir, "skills") },
    { source: "workshop", dir: path.join(params.agentDir, "workshop-skills") },
    // Personal-library revisions: skill-library/<id>/revisions/<hash>/SKILL.md.
    { source: "library", dir: path.join(params.stateDir, "skill-library") },
  );
  for (const dir of params.extraDirs ?? []) {
    if (dir === "~" || dir.startsWith("~/")) {
      for (const home of params.homes) {
        roots.push({ source: "extra", dir: path.join(home, dir.slice(1)) });
      }
    } else {
      roots.push({ source: "extra", dir: path.resolve(dir) });
    }
  }
  const seen = new Set<string>();
  return roots.filter((root) => {
    const key = path.resolve(root.dir);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

/** A readable label: frontmatter `name`, else the folder name. Never used to decide. */
export function parseSkillName(skillMd: string, dir: string): string {
  const frontmatter = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---/u.exec(skillMd.replace(/^﻿/u, ""));
  const line = frontmatter?.[1]?.split(/\r?\n/u).find((entry) => /^name\s*:/u.test(entry));
  const value = line
    ?.slice(line.indexOf(":") + 1)
    .replace(/\s+#.*$/u, "")
    .trim()
    .replace(/^(["'])(.*)\1$/u, "$2")
    .trim();
  return value || path.basename(dir).trim();
}

/** OpenClaw tests for SKILL.md with lstat, which is case-insensitive on a default macOS disk. */
async function hasSkillMd(dir: string): Promise<boolean> {
  try {
    await lstat(path.join(dir, "SKILL.md"));
    return true;
  } catch (error) {
    if (isMissing(error)) {
      return false;
    }
    throw error;
  }
}

/**
 * Every folder under `root` that holds a SKILL.md, without descending into a
 * skill. Each path is reported, even when two paths are the same folder through
 * a symlink: OpenClaw names a skill by the path it found it at. Loops are cut
 * per branch, and the walk stops at MAX_DIRS_PER_ROOT. A folder that exists
 * but cannot be read is a problem, never a folder without skills.
 */
async function findSkillDirs(
  root: string,
): Promise<{ dirs: string[]; truncated: boolean; errors: string[] }> {
  const dirs: string[] = [];
  const errors: string[] = [];
  let visited = 0;
  let truncated = false;
  const walk = async (dir: string, ancestors: Set<string>): Promise<void> => {
    if (truncated) {
      return;
    }
    let real: string;
    try {
      real = await realpath(dir);
    } catch (error) {
      if (!isMissing(error)) {
        errors.push(`${dir}: ${errorText(error)}`);
      }
      return;
    }
    if (ancestors.has(real)) {
      return;
    }
    visited += 1;
    if (visited > MAX_DIRS_PER_ROOT) {
      truncated = true;
      return;
    }
    let entries;
    try {
      if (await hasSkillMd(dir)) {
        dirs.push(dir);
        return;
      }
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (!isMissing(error)) {
        errors.push(`${dir}: ${errorText(error)}`);
      }
      return;
    }
    const branch = new Set(ancestors).add(real);
    for (const entry of entries.toSorted((a, b) => a.name.localeCompare(b.name))) {
      const child = path.join(dir, entry.name);
      if (entry.isDirectory() || entry.isSymbolicLink()) {
        await walk(child, branch);
      }
    }
  };
  await walk(root, new Set());
  return { dirs, truncated, errors };
}

async function readSkillMd(dir: string): Promise<string | { problem: string }> {
  try {
    return (await readRegularFile(path.join(dir, "SKILL.md"), MAX_SKILL_MD_BYTES)).toString("utf8");
  } catch (error) {
    return { problem: errorText(error) };
  }
}

export type SkillFile = { rel: string; abs: string; signature: string; exec: boolean };

/** Every file of a skill, symlinks followed, sorted by relative path. */
export async function listSkillFiles(dir: string): Promise<SkillFile[] | { problem: string }> {
  const files: SkillFile[] = [];
  let bytes = 0;
  let dirs = 0;
  const walk = async (
    abs: string,
    rel: string,
    ancestors: Set<string>,
  ): Promise<string | undefined> => {
    const real = await realpath(abs);
    if (ancestors.has(real)) {
      return undefined;
    }
    dirs += 1;
    if (dirs > MAX_SKILL_DIRS) {
      return `more than ${MAX_SKILL_DIRS} folders`;
    }
    const branch = new Set(ancestors).add(real);
    for (const name of (await readdir(abs)).toSorted()) {
      const childAbs = path.join(abs, name);
      const childRel = rel ? `${rel}/${name}` : name;
      const info = await stat(childAbs);
      if (info.isDirectory()) {
        const problem = await walk(childAbs, childRel, branch);
        if (problem) {
          return problem;
        }
        continue;
      }
      if (!info.isFile()) {
        return `"${childRel}" is not a regular file`;
      }
      bytes += info.size;
      // ctime and inode cannot be set back by whoever edits the file.
      files.push({
        rel: childRel,
        abs: childAbs,
        signature: `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}:${info.mode}`,
        exec: (info.mode & 0o111) !== 0,
      });
      if (files.length > MAX_SKILL_FILES || bytes > MAX_SKILL_BYTES) {
        return `more than ${MAX_SKILL_FILES} files or ${MAX_SKILL_BYTES / 1024 / 1024} MiB`;
      }
    }
    return undefined;
  };
  try {
    const problem = await walk(dir, "", new Set());
    return problem
      ? { problem }
      : files.toSorted((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  } catch (error) {
    return { problem: error instanceof Error ? error.message : String(error) };
  }
}

export type HashedSkillFile = { rel: string; exec: boolean; length: number; sha256: string };

export function hashSkillFile(rel: string, exec: boolean, content: Buffer): HashedSkillFile {
  return {
    rel,
    exec,
    length: content.length,
    sha256: createHash("sha256").update(content).digest("hex"),
  };
}

/**
 * A skill's fingerprint: its folder name, then each file's path, executable
 * bit, size and content hash, in path order. The folder name is part of a
 * skill's identity: OpenClaw names a skill without a frontmatter name after it.
 */
export function fingerprintSkillFiles(folder: string, files: HashedSkillFile[]): string {
  const tree = createHash("sha256").update(`folder\0${folder}\n`);
  for (const file of files.toSorted((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))) {
    tree.update(`${file.rel}\0${file.exec ? 1 : 0}\0${file.length}\0${file.sha256}\n`);
  }
  return `sha256:${tree.digest("hex")}`;
}

/**
 * Finds and fingerprints skills. A fingerprint is cached per path and reused
 * only while every file keeps its inode, size, mtime, ctime and mode.
 */
export function createSkillScanner() {
  const cache = new Map<string, { signature: string; fingerprint: string; bytes: number }>();

  const fingerprint = async (
    dir: string,
  ): Promise<{ fingerprint: string; files: number; bytes: number } | { problem: string }> => {
    const files = await listSkillFiles(dir);
    if (!Array.isArray(files)) {
      return files;
    }
    const folder = path.basename(dir);
    const signature = [folder, ...files.map((file) => `${file.rel}\0${file.signature}`)].join("\n");
    const cached = cache.get(dir);
    if (cached?.signature === signature) {
      return { fingerprint: cached.fingerprint, files: files.length, bytes: cached.bytes };
    }
    const hashed: HashedSkillFile[] = [];
    let bytes = 0;
    try {
      for (const file of files) {
        const content = await readRegularFile(file.abs);
        bytes += content.length;
        hashed.push(hashSkillFile(file.rel, file.exec, content));
      }
    } catch (error) {
      return { problem: error instanceof Error ? error.message : String(error) };
    }
    const result = fingerprintSkillFiles(folder, hashed);
    cache.set(dir, { signature, fingerprint: result, bytes });
    return { fingerprint: result, files: files.length, bytes };
  };

  return {
    async scan(roots: SkillRoot[]): Promise<SkillScan> {
      const skills: FoundSkill[] = [];
      const problems: string[] = [];
      const seen = new Set<string>();
      for (const root of roots) {
        const { dirs, truncated, errors } = await findSkillDirs(root.dir);
        problems.push(...errors.map((error) => `${root.source} skills: ${error}`));
        if (truncated) {
          problems.push(
            `${root.source} skills at ${root.dir} hold more than ${MAX_DIRS_PER_ROOT} folders`,
          );
        }
        for (const dir of dirs) {
          if (seen.has(dir)) {
            continue;
          }
          seen.add(dir);
          const skillMd = await readSkillMd(dir);
          const name = parseSkillName(typeof skillMd === "string" ? skillMd : "", dir);
          const result = typeof skillMd === "string" ? await fingerprint(dir) : skillMd;
          skills.push(
            "problem" in result
              ? {
                  name,
                  source: root.source,
                  dir,
                  fingerprint: null,
                  files: 0,
                  bytes: 0,
                  problem: result.problem,
                }
              : { name, source: root.source, dir, ...result },
          );
        }
      }
      return { skills, problems };
    },
  };
}

/**
 * The skills whose fingerprint is not approved. An approval of any name counts:
 * the fingerprint already binds the folder name and content.
 */
export function findUnapprovedSkills(
  skills: FoundSkill[],
  approved: Record<string, string[]>,
): SkillRefusal[] {
  const approvedPrints = new Set(Object.values(approved).flat());
  const refusals: SkillRefusal[] = [];
  for (const skill of skills) {
    if (!skill.fingerprint) {
      refusals.push({ skill, reason: "unreadable" });
    } else if (!approvedPrints.has(skill.fingerprint)) {
      const earlier = Object.hasOwn(approved, skill.name) && approved[skill.name]!.length > 0;
      refusals.push({ skill, reason: earlier ? "changed" : "unapproved" });
    }
  }
  return refusals;
}

const REASON_TEXT: Record<SkillRefusal["reason"], string> = {
  unapproved: "not approved",
  changed: "changed since it was approved",
  unreadable: "could not be read",
};

export function describeSkillRefusal(refusal: SkillRefusal): string {
  const detail = refusal.skill.problem ? `: ${refusal.skill.problem}` : "";
  return `"${refusal.skill.name}" (${refusal.skill.source} skill, ${REASON_TEXT[refusal.reason]}${detail})`;
}
