import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyMemoryEntryMutation,
  listMemoryEntries,
  parseMemoryEntryId,
  readMemoryEntry,
} from "./memory-entries.js";

describe("memory entries", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const dir of dirs.splice(0)) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  async function workspace(): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-memory-entries-"));
    dirs.push(dir);
    await fs.writeFile(
      path.join(dir, "MEMORY.md"),
      "# Memory\n\n- Prefers Italian.\n- Meetings after 10:00.\n",
    );
    await fs.mkdir(path.join(dir, "memory"));
    await fs.writeFile(
      path.join(dir, "memory", "2026-09-19.md"),
      "Rossi invoice overdue.\n\nBianchi contract signed.\n",
    );
    return dir;
  }

  it("lists every non-heading line with a file#line id", async () => {
    const dir = await workspace();
    const entries = await listMemoryEntries(dir);
    expect(entries.map((entry) => entry.id)).toEqual([
      "MEMORY.md#3",
      "MEMORY.md#4",
      "memory/2026-09-19.md#1",
      "memory/2026-09-19.md#3",
    ]);
    expect((await readMemoryEntry(dir, "MEMORY.md#4"))?.text).toBe("- Meetings after 10:00.");
  });

  it("edits and deletes one entry in place, keeping the bullet prefix", async () => {
    const dir = await workspace();
    const before = await applyMemoryEntryMutation(dir, {
      op: "edit",
      id: "MEMORY.md#4",
      text: "Meetings after 11:00.",
    });
    expect(before.text).toBe("- Meetings after 10:00.");
    expect(await fs.readFile(path.join(dir, "MEMORY.md"), "utf8")).toContain(
      "- Meetings after 11:00.",
    );
    await applyMemoryEntryMutation(dir, { op: "delete", id: "memory/2026-09-19.md#1" });
    const notes = await fs.readFile(path.join(dir, "memory", "2026-09-19.md"), "utf8");
    expect(notes).not.toContain("Rossi");
    expect(notes).toContain("Bianchi contract signed.");
  });

  it("rejects ids outside the memory files and missing lines", async () => {
    const dir = await workspace();
    expect(parseMemoryEntryId("../openclaw.json#1")).toBeNull();
    expect(parseMemoryEntryId("memory/../../x.md#1")).toBeNull();
    expect(parseMemoryEntryId("MEMORY.md#0")).toBeNull();
    await expect(
      applyMemoryEntryMutation(dir, { op: "delete", id: "MEMORY.md#99" }),
    ).rejects.toThrow(/does not exist/);
    await expect(applyMemoryEntryMutation(dir, { op: "delete", id: "SOUL.md#1" })).rejects.toThrow(
      /Invalid memory entry id/,
    );
  });
});
