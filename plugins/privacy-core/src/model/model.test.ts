// `openclaw privacy model`: which enclave model the private Inbox agent uses.
import { describe, expect, it } from "vitest";
import type { MailCliDeps } from "../mail/connect.js";
import { buildPrivateConfig, packageSpecs } from "../setup/plan.js";
import {
  catalogEntry,
  formatModelList,
  listEnclaveModels,
  parseEnclaveModels,
  setEnclaveModel,
  type ModelCliDeps,
} from "./model.js";

// The shape Tinfoil's /v1/models returns (trimmed to the fields that matter).
const deepseek = {
  id: "deepseek-v4-1-flash",
  name: "DeepSeek V4.1 Flash",
  type: "chat",
  context_window: 1_048_576,
  tool_calling: true,
  reasoning: true,
  experimental: true,
  pricing: { inputTokenPricePer1M: 0.65, outputTokenPricePer1M: 1.45 },
  reasoning_params: {
    params: {
      "/v1/chat/completions": {
        enable: { chat_template_kwargs: { reasoning_effort: "$EFFORT", thinking: true } },
      },
    },
  },
};
const gptOss = {
  id: "gpt-oss-120b",
  name: "GPT-OSS 120B",
  type: "chat",
  context_window: 131_072,
  tool_calling: true,
  reasoning: true,
  pricing: { inputTokenPricePer1M: 0.15, outputTokenPricePer1M: 0.6 },
  reasoning_params: {
    params: { "/v1/chat/completions": { enable: { reasoning_effort: "$EFFORT" } } },
  },
};
const noTools = { id: "llama-no-tools", name: "Llama No Tools", type: "chat", tool_calling: false };
const LIVE = {
  object: "list",
  data: [
    gptOss,
    deepseek,
    noTools,
    { id: "nomic-embed-text", type: "embedding" },
    { id: "whisper-large-v3-turbo", type: "audio" },
    { name: "missing id", type: "chat" },
  ],
};

const tinfoilPrivateConfig = () =>
  buildPrivateConfig({
    provider: "tinfoil",
    privatePort: 19789,
    packVersion: "0.4.0",
    packages: packageSpecs("tinfoil", "0.4.0"),
  });

function fakeDeps(config: unknown, live: unknown = LIVE) {
  const files = new Map<string, string>(
    config === undefined ? [] : [["/p/openclaw.json", JSON.stringify(config)]],
  );
  const calls: string[][] = [];
  const fetched: string[] = [];
  const logs: string[] = [];
  const deps: ModelCliDeps = {
    openclawPrivate: async (args) => {
      calls.push(args);
      return args.includes("status")
        ? { code: 0, stdout: JSON.stringify({ mode: "private", issues: [] }), stderr: "" }
        : { code: 0, stdout: "", stderr: "" };
    },
    privateConfigPath: "/p/openclaw.json",
    readFile: async (file) => files.get(file),
    writeFileAtomic: async (file, content) => void files.set(file, content),
    log: (line) => logs.push(line),
    fetchJson: async (url) => {
      fetched.push(url);
      if (live instanceof Error) {
        throw live;
      }
      return live;
    },
  } satisfies MailCliDeps & Pick<ModelCliDeps, "fetchJson">;
  const written = () =>
    JSON.parse(files.get("/p/openclaw.json") ?? "{}") as ReturnType<typeof tinfoilPrivateConfig> & {
      agents: { defaults: { model: unknown }; entries: Record<string, { model?: unknown }> };
      models: { providers: Record<string, { models: Array<Record<string, unknown>> }> };
    };
  return { deps, files, calls, fetched, logs, written };
}

const signal = () => AbortSignal.timeout(5_000);

describe("enclave model list", () => {
  it("keeps chat models only, sorted, and reads their tool, price and thinking facts", () => {
    const models = parseEnclaveModels(LIVE);
    expect(models.map((m) => m.id)).toEqual([
      "deepseek-v4-1-flash",
      "gpt-oss-120b",
      "llama-no-tools",
    ]);
    expect(models[0]).toEqual({
      id: "deepseek-v4-1-flash",
      name: "DeepSeek V4.1 Flash",
      contextWindow: 1_048_576,
      toolCalling: true,
      reasoning: true,
      reasoningEffortTopLevel: false,
      experimental: true,
      inputPrice: 0.65,
      outputPrice: 1.45,
    });
    expect(models[1]?.reasoningEffortTopLevel).toBe(true);
    expect(models[2]).toMatchObject({ toolCalling: false, name: "Llama No Tools" });
  });

  it("refuses an answer that is not a model list", () => {
    expect(() => parseEnclaveModels({ data: "nope" })).toThrow("not a model list");
    expect(() => parseEnclaveModels(null)).toThrow("not a model list");
  });

  it("describes a catalog entry OpenClaw can drive, without thinking controls it cannot send", () => {
    const [deepseekModel, gptModel] = parseEnclaveModels(LIVE);
    if (!deepseekModel || !gptModel) {
      throw new Error("the fixture should hold both chat models");
    }
    expect(catalogEntry(deepseekModel, "Tinfoil")).toEqual({
      id: "deepseek-v4-1-flash",
      name: "DeepSeek V4.1 Flash (Tinfoil enclave)",
      reasoning: false,
      input: ["text"],
      contextWindow: 1_048_576,
      maxTokens: 32_768,
    });
    expect(catalogEntry(gptModel, "Tinfoil")).toMatchObject({
      id: "gpt-oss-120b",
      reasoning: true,
    });
  });

  it("asks the private gateway's attested relay, and shows the models the Inbox agent can use", async () => {
    const fake = fakeDeps(tinfoilPrivateConfig());
    const listed = await listEnclaveModels(fake.deps, signal());
    expect(fake.fetched).toEqual(["http://127.0.0.1:19931/v1/models"]);
    expect(listed.currentRef).toBe("tinfoil/gpt-oss-120b");
    const text = formatModelList(listed).join("\n");
    expect(text).toContain("The Inbox agent uses: gpt-oss-120b on Tinfoil (tinfoil/gpt-oss-120b)");
    expect(text).toMatch(
      /deepseek-v4-1-flash +DeepSeek V4\.1 Flash +1M context +\$0\.65 in \/ \$1\.45 out per 1M tokens +experimental/u,
    );
    expect(text).toMatch(/\* gpt-oss-120b +GPT-OSS 120B +128K context .*\(in use\)/u);
    expect(text).not.toContain("llama-no-tools");
    // Columns line up whatever the context size label's length.
    const rows = text.split("\n").filter((line) => line.includes(" per 1M tokens"));
    expect(new Set(rows.map((line) => line.indexOf("$"))).size).toBe(1);
    expect(text).toContain("Switch with: openclaw privacy model set <id>");
  });

  it("says how to start the private gateway when its relay does not answer", async () => {
    const fake = fakeDeps(
      tinfoilPrivateConfig(),
      new Error("connect ECONNREFUSED 127.0.0.1:19931"),
    );
    await expect(listEnclaveModels(fake.deps, signal())).rejects.toThrow(
      "openclaw --profile private gateway start",
    );
  });

  it("says to run setup when there is no private gateway", async () => {
    const fake = fakeDeps(undefined);
    await expect(listEnclaveModels(fake.deps, signal())).rejects.toThrow("openclaw privacy setup");
  });

  it("only works for an enclave provider", async () => {
    const config = tinfoilPrivateConfig() as { agents: { defaults: { model: string } } };
    config.agents.defaults.model = "ollama/llama3";
    const fake = fakeDeps(config);
    await expect(listEnclaveModels(fake.deps, signal())).rejects.toThrow("not an enclave model");
    expect(fake.fetched).toEqual([]);
  });
});

describe("switching the Inbox agent's model", () => {
  it("adds the model to the catalog, makes it the Inbox model, restarts and checks the gateway", async () => {
    const fake = fakeDeps(tinfoilPrivateConfig());
    const outcome = await setEnclaveModel("deepseek-v4-1-flash", fake.deps, signal());
    expect(outcome).toEqual({ changed: true, ref: "tinfoil/deepseek-v4-1-flash", warnings: [] });
    const config = fake.written();
    expect(config.agents.defaults.model).toBe("tinfoil/deepseek-v4-1-flash");
    expect(config.models.providers.tinfoil?.models.map((m) => m.id)).toEqual([
      "gpt-oss-120b",
      "deepseek-v4-1-flash",
    ]);
    expect(fake.calls).toEqual([
      ["gateway", "restart"],
      ["privacy", "status", "--json"],
    ]);
  });

  it("updates the Inbox agent's own model when it has one, keeping fallbacks", async () => {
    const config = tinfoilPrivateConfig() as {
      agents: { entries: Record<string, { model?: unknown }> };
    };
    config.agents.entries.inbox = {
      ...config.agents.entries.inbox,
      model: { primary: "tinfoil/gpt-oss-120b", fallbacks: ["tinfoil/gemma4-31b"] },
    };
    const fake = fakeDeps(config);
    await setEnclaveModel("deepseek-v4-1-flash", fake.deps, signal());
    expect(fake.written().agents.entries.inbox?.model).toEqual({
      primary: "tinfoil/deepseek-v4-1-flash",
      fallbacks: ["tinfoil/gemma4-31b"],
    });
  });

  it("changes nothing when the model is already in use", async () => {
    const fake = fakeDeps(tinfoilPrivateConfig());
    const before = fake.files.get("/p/openclaw.json");
    const outcome = await setEnclaveModel("gpt-oss-120b", fake.deps, signal());
    expect(outcome.changed).toBe(false);
    expect(fake.files.get("/p/openclaw.json")).toBe(before);
    expect(fake.calls).toEqual([]);
  });

  it("refuses a model the enclave does not offer, listing the ones it does", async () => {
    const fake = fakeDeps(tinfoilPrivateConfig());
    await expect(setEnclaveModel("deepseek-v4-flash", fake.deps, signal())).rejects.toThrow(
      'Tinfoil does not offer "deepseek-v4-flash" right now. Choose one of: deepseek-v4-1-flash, gpt-oss-120b',
    );
    expect(fake.calls).toEqual([]);
  });

  it("refuses a model that cannot use tools, since the Inbox agent reads email with them", async () => {
    const fake = fakeDeps(tinfoilPrivateConfig());
    await expect(setEnclaveModel("llama-no-tools", fake.deps, signal())).rejects.toThrow(
      "Llama No Tools cannot use tools",
    );
    expect(fake.calls).toEqual([]);
  });
});
