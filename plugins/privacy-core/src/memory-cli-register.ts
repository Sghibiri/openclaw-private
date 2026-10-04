// `openclaw privacy memory list|show|edit|delete`: the operator can see and
// change every memory entry an agent keeps.
import type { OpenClawConfig } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";

type CliProgram = Parameters<Parameters<OpenClawPluginApi["registerCli"]>[0]>[0]["program"];
type PrivacyCommand = ReturnType<CliProgram["command"]>;

type Options = { agent?: string; json?: boolean };

export function registerPrivacyMemoryCli(privacy: PrivacyCommand, config: () => unknown): void {
  const load = async () => {
    const runtime = await import("./memory-cli.js");
    runtime.setMemoryCliConfigSource(() => config() as OpenClawConfig);
    return runtime;
  };
  const memory = privacy
    .command("memory")
    .description("See, edit and delete what an agent remembers (MEMORY.md and memory/*.md)");
  memory
    .command("list")
    .description("List every memory entry with an id")
    .option("--agent <id>", "Agent id (default: the default agent)")
    .option("--json", "Print JSON")
    .action(async (opts: Options) => {
      await (await load()).runMemoryList(opts);
    });
  memory
    .command("show")
    .description("Show one memory entry")
    .argument("<id>", "Entry id from `privacy memory list` (file#line)")
    .option("--agent <id>", "Agent id (default: the default agent)")
    .option("--json", "Print JSON")
    .action(async (id: string, opts: Options) => {
      await (await load()).runMemoryShow(id, opts);
    });
  memory
    .command("edit")
    .description("Rewrite one memory entry")
    .argument("<id>", "Entry id from `privacy memory list` (file#line)")
    .argument("<text>", "New text for the entry")
    .option("--agent <id>", "Agent id (default: the default agent)")
    .option("--json", "Print JSON")
    .action(async (id: string, text: string, opts: Options) => {
      await (await load()).runMemoryEdit(id, text, opts);
    });
  memory
    .command("delete")
    .description("Delete one memory entry")
    .argument("<id>", "Entry id from `privacy memory list` (file#line)")
    .option("--agent <id>", "Agent id (default: the default agent)")
    .option("--json", "Print JSON")
    .action(async (id: string, opts: Options) => {
      await (await load()).runMemoryDelete(id, opts);
    });
}
