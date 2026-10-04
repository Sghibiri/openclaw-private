// Memory entries as a person sees them: every non-empty line of MEMORY.md and
// of the daily notes under memory/, addressable, editable and deletable.
// Ids are `<relative file>#<line number>` and are recomputed on every listing,
// so an id is valid for the file content it was listed from.
import fs from "node:fs/promises";
import path from "node:path";

export const CURATED_MEMORY_FILE = "MEMORY.md";
export const MEMORY_NOTES_DIR = "memory";

export type MemoryEntry = {
  id: string;
  file: string;
  line: number;
  text: string;
};

export type MemoryEntryMutation =
  | { op: "edit"; id: string; text: string }
  | { op: "delete"; id: string };

async function listMemoryFiles(workspaceDir: string): Promise<string[]> {
  const files: string[] = [];
  try {
    await fs.access(path.join(workspaceDir, CURATED_MEMORY_FILE));
    files.push(CURATED_MEMORY_FILE);
  } catch {
    // No curated memory file yet.
  }
  const notesDir = path.join(workspaceDir, MEMORY_NOTES_DIR);
  try {
    const names = await fs.readdir(notesDir);
    for (const name of names.filter((entry) => entry.endsWith(".md")).toSorted()) {
      files.push(path.posix.join(MEMORY_NOTES_DIR, name));
    }
  } catch {
    // No notes directory yet.
  }
  return files;
}

export function parseMemoryEntries(file: string, content: string): MemoryEntry[] {
  return content.split(/\r?\n/u).flatMap((raw, index) => {
    const text = raw.trim();
    if (!text || /^#{1,6}\s/u.test(text)) {
      return [];
    }
    return [{ id: `${file}#${index + 1}`, file, line: index + 1, text: raw }];
  });
}

export function parseMemoryEntryId(id: string): { file: string; line: number } | null {
  const match = /^(.+)#(\d+)$/u.exec(id.trim());
  if (!match) {
    return null;
  }
  const file = match[1] ?? "";
  const line = Number(match[2]);
  if (!Number.isInteger(line) || line < 1) {
    return null;
  }
  const normalized = path.posix.normalize(file);
  const inWorkspace =
    normalized === CURATED_MEMORY_FILE ||
    (normalized.startsWith(`${MEMORY_NOTES_DIR}/`) && !normalized.includes(".."));
  return inWorkspace ? { file: normalized, line } : null;
}

export async function listMemoryEntries(workspaceDir: string): Promise<MemoryEntry[]> {
  const entries: MemoryEntry[] = [];
  for (const file of await listMemoryFiles(workspaceDir)) {
    const content = await fs.readFile(path.join(workspaceDir, file), "utf8");
    entries.push(...parseMemoryEntries(file, content));
  }
  return entries;
}

export async function readMemoryEntry(
  workspaceDir: string,
  id: string,
): Promise<MemoryEntry | null> {
  const parsed = parseMemoryEntryId(id);
  if (!parsed) {
    return null;
  }
  const entries = await listMemoryEntries(workspaceDir);
  return entries.find((entry) => entry.file === parsed.file && entry.line === parsed.line) ?? null;
}

/** Apply one edit or delete in place. Returns the entry as it was before. */
export async function applyMemoryEntryMutation(
  workspaceDir: string,
  mutation: MemoryEntryMutation,
): Promise<MemoryEntry> {
  const parsed = parseMemoryEntryId(mutation.id);
  if (!parsed) {
    throw new Error(
      `Invalid memory entry id "${mutation.id}". Use an id from \`openclaw memory list\`.`,
    );
  }
  const filePath = path.join(workspaceDir, parsed.file);
  const content = await fs.readFile(filePath, "utf8");
  const lines = content.split(/\r?\n/u);
  const index = parsed.line - 1;
  const before = lines[index];
  if (before === undefined || !before.trim()) {
    throw new Error(
      `Memory entry "${mutation.id}" does not exist. List entries again for current ids.`,
    );
  }
  if (mutation.op === "edit") {
    const text = mutation.text.replace(/\r?\n/gu, " ").trim();
    if (!text) {
      throw new Error("Use `delete` to remove an entry; an edit needs non-empty text.");
    }
    const indent = /^\s*(?:[-*]\s+)?/u.exec(before)?.[0] ?? "";
    lines[index] = `${indent}${text}`;
  } else {
    lines.splice(index, 1);
  }
  await fs.writeFile(filePath, lines.join("\n"), "utf8");
  return { id: mutation.id, file: parsed.file, line: parsed.line, text: before };
}
