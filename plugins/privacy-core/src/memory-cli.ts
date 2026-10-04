// `openclaw privacy memory list|show|edit|delete`: every memory entry viewable,
// editable and deletable by the operator. Edits change the files under the
// agent workspace; the search index is rebuilt on the next `memory index`.
import { resolveDefaultAgentId } from "openclaw/plugin-sdk/agent-scope-runtime";
import {
  resolveAgentWorkspaceDir,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import {
  applyMemoryEntryMutation,
  listMemoryEntries,
  readMemoryEntry,
  type MemoryEntry,
} from "./memory-entries.js";

export type MemoryEntriesCommandOptions = { agent?: string; json?: boolean };

type Output = { log: (line: string) => void };

let configSource: () => OpenClawConfig = () => {
  throw new Error("privacy memory commands need the gateway config");
};

/** The CLI registrar hands in the loaded config before any command runs. */
export function setMemoryCliConfigSource(source: () => OpenClawConfig): void {
  configSource = source;
}

function resolveWorkspace(agent?: string): { agentId: string; workspaceDir: string } {
  const cfg = configSource();
  const agentId = agent?.trim() || resolveDefaultAgentId(cfg);
  return { agentId, workspaceDir: resolveAgentWorkspaceDir(cfg, agentId) };
}

function formatEntry(entry: MemoryEntry): string {
  return `${entry.id.padEnd(28)} ${entry.text.trim()}`;
}

export async function runMemoryList(
  opts: MemoryEntriesCommandOptions,
  output: Output = console,
): Promise<MemoryEntry[]> {
  const { agentId, workspaceDir } = resolveWorkspace(opts.agent);
  const entries = await listMemoryEntries(workspaceDir);
  if (opts.json) {
    output.log(JSON.stringify({ agentId, workspaceDir, entries }, null, 2));
  } else if (entries.length === 0) {
    output.log(`No memory entries for agent "${agentId}" under ${workspaceDir}.`);
  } else {
    output.log(`Memory entries for agent "${agentId}" (${entries.length}):`);
    for (const entry of entries) {
      output.log(formatEntry(entry));
    }
  }
  return entries;
}

export async function runMemoryShow(
  id: string,
  opts: MemoryEntriesCommandOptions,
  output: Output = console,
): Promise<MemoryEntry> {
  const { agentId, workspaceDir } = resolveWorkspace(opts.agent);
  const entry = await readMemoryEntry(workspaceDir, id);
  if (!entry) {
    throw new Error(`Memory entry "${id}" not found for agent "${agentId}".`);
  }
  output.log(opts.json ? JSON.stringify({ agentId, entry }, null, 2) : entry.text);
  return entry;
}

export async function runMemoryEdit(
  id: string,
  text: string,
  opts: MemoryEntriesCommandOptions,
  output: Output = console,
): Promise<MemoryEntry> {
  const { agentId, workspaceDir } = resolveWorkspace(opts.agent);
  const before = await applyMemoryEntryMutation(workspaceDir, { op: "edit", id, text });
  output.log(
    opts.json
      ? JSON.stringify({ agentId, id, before: before.text, after: text }, null, 2)
      : `Edited ${id} for agent "${agentId}". Run \`openclaw memory index --agent ${agentId}\` to refresh search.`,
  );
  return before;
}

export async function runMemoryDelete(
  id: string,
  opts: MemoryEntriesCommandOptions,
  output: Output = console,
): Promise<MemoryEntry> {
  const { agentId, workspaceDir } = resolveWorkspace(opts.agent);
  const before = await applyMemoryEntryMutation(workspaceDir, { op: "delete", id });
  output.log(
    opts.json
      ? JSON.stringify({ agentId, id, deleted: before.text }, null, 2)
      : `Deleted ${id} for agent "${agentId}". Run \`openclaw memory index --agent ${agentId}\` to refresh search.`,
  );
  return before;
}
