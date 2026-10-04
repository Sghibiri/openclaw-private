import { describe, expect, it } from "vitest";
import { resolvePrivacySettings } from "./settings.js";
import { resolveProviderTrust } from "./trust.js";
import { resolveEgressAllowlist, validatePrivacyConfig, type HostConfig } from "./validate.js";

const privateSettings = (extra: Record<string, unknown> = {}) =>
  resolvePrivacySettings({ mode: "private", ...extra });

function privateConfig(overrides: Partial<HostConfig> = {}): HostConfig {
  return {
    agents: {
      defaults: { model: "tinfoil/gpt-oss-120b", sandbox: { mode: "all" } },
      entries: { inbox: { model: "tinfoil/gpt-oss-120b", skills: [] } },
    },
    plugins: {
      allow: ["tinfoil", "a2a", "privacy-core"],
      entries: { "privacy-core": { hooks: { allowConversationAccess: true } } },
    },
    channels: { a2a: { enabled: true } },
    proxy: { proxyUrl: "http://127.0.0.1:19930" },
    browser: { evaluateEnabled: false },
    skills: { workshop: { autonomous: { mode: "off" }, approvalPolicy: "pending" } },
    ...overrides,
  };
}

const paths = (issues: Array<{ path: string }>) => issues.map((issue) => issue.path);

describe("validatePrivacyConfig: private mode", () => {
  it("accepts the private baseline", () => {
    expect(validatePrivacyConfig(privateConfig(), privateSettings())).toEqual([]);
  });

  it("does nothing on a standard gateway without residency", () => {
    expect(
      validatePrivacyConfig(
        { agents: { defaults: { model: "anthropic/claude-opus-5" } } },
        resolvePrivacySettings({}),
      ),
    ).toEqual([]);
  });

  it("refuses an unattested provider and names the key", () => {
    const issues = validatePrivacyConfig(
      privateConfig({
        agents: {
          defaults: { model: "tinfoil/gpt-oss-120b", sandbox: { mode: "all" } },
          entries: { inbox: { model: "anthropic/claude-opus-5", skills: [] } },
        },
      }),
      privateSettings(),
    );
    expect(paths(issues)).toEqual(["agents.entries.inbox.model"]);
    expect(issues[0]?.message).toContain('provider "anthropic" is not allowed in private mode');
  });

  it("refuses an attested provider pointed around its relay", () => {
    const issues = validatePrivacyConfig(
      privateConfig({
        models: { providers: { tinfoil: { baseUrl: "https://inference.tinfoil.sh/v1" } } },
      }),
      privateSettings(),
    );
    expect(paths(issues)).toContain("models.providers.tinfoil.baseUrl");
    expect(issues[0]?.message).toContain("http://127.0.0.1:19931/v1");
    expect(
      validatePrivacyConfig(
        privateConfig({
          models: { providers: { tinfoil: { baseUrl: "http://127.0.0.1:19931/v1/" } } },
        }),
        privateSettings(),
      ),
    ).toEqual([]);
  });

  it("requires the provider's plugin to be allowed", () => {
    const issues = validatePrivacyConfig(
      privateConfig({
        plugins: {
          allow: ["a2a", "privacy-core"],
          entries: { "privacy-core": { hooks: { allowConversationAccess: true } } },
        },
      }),
      privateSettings(),
    );
    expect(issues.map((issue) => issue.message)).toContain(
      '"tinfoil/gpt-oss-120b" needs the "tinfoil" plugin in plugins.allow',
    );
  });

  it("refuses tinfoil for residency eu and accepts privatemode", () => {
    const eu = (model: string) =>
      privateConfig({
        agents: { defaults: { model, sandbox: { mode: "all" } }, entries: {} },
        plugins: {
          allow: ["tinfoil", "privatemode", "a2a", "privacy-core"],
          entries: { "privacy-core": { hooks: { allowConversationAccess: true } } },
        },
      });
    const refused = validatePrivacyConfig(
      eu("tinfoil/gpt-oss-120b"),
      privateSettings({ residency: "eu" }),
    );
    expect(paths(refused)).toEqual(["agents.defaults.model"]);
    expect(refused[0]?.message).toContain("not EU-resident");
    expect(
      validatePrivacyConfig(eu("privatemode/gpt-oss-120b"), privateSettings({ residency: "eu" })),
    ).toEqual([]);
  });

  it("allows ollama only on a loopback base url", () => {
    const withOllama = (baseUrl: string) =>
      privateConfig({
        agents: { defaults: { model: "ollama/llama3", sandbox: { mode: "all" } }, entries: {} },
        models: { providers: { ollama: { baseUrl } } },
        plugins: {
          allow: ["ollama", "a2a", "privacy-core"],
          entries: { "privacy-core": { hooks: { allowConversationAccess: true } } },
        },
      });
    expect(validatePrivacyConfig(withOllama("http://127.0.0.1:11434"), privateSettings())).toEqual(
      [],
    );
    expect(
      paths(validatePrivacyConfig(withOllama("https://ollama.example.com"), privateSettings())),
    ).toEqual(["agents.defaults.model"]);
  });

  it("requires an explicit default model", () => {
    const issues = validatePrivacyConfig(
      privateConfig({
        agents: { defaults: { sandbox: { mode: "all" } }, entries: { inbox: { skills: [] } } },
      }),
      privateSettings(),
    );
    expect(paths(issues)).toEqual(["agents.defaults.model"]);
    expect(issues[0]?.message).toContain("tinfoil/gpt-oss-120b");
  });

  it("checks fallbacks, sandbox, channels, plugins, skills, keys and runtimes", () => {
    const issues = validatePrivacyConfig(
      {
        agents: {
          defaults: {
            model: { primary: "tinfoil/gpt-oss-120b", fallbacks: ["openai/gpt-6"] },
            sandbox: { mode: "non-main", browser: { allowHostControl: true } },
          },
          entries: { inbox: { model: "tinfoil/gpt-oss-120b", sandbox: { mode: "off" } } },
        },
        models: {
          providers: {
            tinfoil: { apiKey: "sk-plaintext" },
            openai: { agentRuntime: { id: "codex" } },
          },
        },
        channels: { telegram: { enabled: true }, a2a: { enabled: true } },
        plugins: { allow: ["tinfoil", "telegram"], load: { paths: [] } },
        skills: { load: { extraDirs: ["/tmp/skills"] }, install: { allowUploadedArchives: true } },
        logging: { audit: { messages: "full" } },
        browser: { allowSystemProfileImport: true },
      },
      privateSettings(),
    );
    expect(paths(issues).toSorted()).toEqual(
      [
        "agents.defaults.model.fallbacks[0]",
        "models.providers.openai.agentRuntime.id",
        "models.providers.tinfoil.apiKey",
        "agents.defaults.sandbox.mode",
        "agents.defaults.sandbox.browser.allowHostControl",
        "agents.entries.inbox.sandbox.mode",
        "agents.entries.inbox.skills",
        "channels.telegram",
        "plugins.allow",
        "plugins.allow",
        "plugins.entries.privacy-core.hooks.allowConversationAccess",
        "skills.load.extraDirs",
        "skills.install.allowUploadedArchives",
        "skills.workshop.autonomous.mode",
        "skills.workshop.approvalPolicy",
        "proxy.proxyUrl",
        "browser.allowSystemProfileImport",
        "browser.evaluateEnabled",
        "logging.audit.messages",
      ].toSorted(),
    );
  });

  it("requires egress through privacy-core's proxy on the configured port", () => {
    const settings = privateSettings({ egress: { proxyPort: 20000 } });
    expect(paths(validatePrivacyConfig(privateConfig(), settings))).toEqual(["proxy.proxyUrl"]);
    expect(
      validatePrivacyConfig(
        privateConfig({ proxy: { proxyUrl: "http://127.0.0.1:20000" } }),
        settings,
      ),
    ).toEqual([]);
    expect(
      paths(
        validatePrivacyConfig(
          privateConfig({ proxy: { proxyUrl: "http://127.0.0.1:19930", loopbackMode: "proxy" } }),
          privateSettings(),
        ),
      ),
    ).toEqual(["proxy.loopbackMode"]);
  });

  it("derives the egress allowlist from the attested providers in use plus egress.allow", () => {
    expect(
      resolveEgressAllowlist(
        privateConfig(),
        privateSettings({ egress: { allow: ["gmail.googleapis.com"] } }),
      ),
    ).toEqual(["*.tinfoil.sh", "atc.tinfoil.sh", "gmail.googleapis.com"]);
    expect(
      paths(
        validatePrivacyConfig(
          privateConfig(),
          privateSettings({ egress: { allow: ["https://bad.example.com/x"] } }),
        ),
      ),
    ).toEqual(["plugins.entries.privacy-core.config.egress.allow"]);
  });
});

describe("validatePrivacyConfig: EU residency on a standard gateway", () => {
  const eu = (extra: Record<string, unknown> = {}) =>
    resolvePrivacySettings({ residency: "eu", ...extra });
  const main = (entries: Record<string, { model: string }>): HostConfig => ({
    agents: { entries },
  });

  it("refuses providers without an EU region and names the next step", () => {
    const issues = validatePrivacyConfig(
      main({
        chief: { model: "anthropic/claude-opus-5" },
        research: { model: "tinfoil/gpt-oss-120b" },
      }),
      eu(),
    );
    expect(paths(issues)).toEqual(["agents.entries.chief.model", "agents.entries.research.model"]);
    expect(issues[0]?.message).toContain(
      'set plugins.entries.privacy-core.config.providers.anthropic.region = "eu"',
    );
    expect(issues[1]?.message).toContain("move the agent to an EU provider");
  });

  it("accepts operator-declared EU providers, privatemode and loopback ollama", () => {
    expect(
      validatePrivacyConfig(
        main({
          chief: { model: "mistral/mistral-large-latest" },
          research: { model: "privatemode/gpt-oss-120b" },
          builder: { model: "ollama/llama3" },
        }),
        eu({ providers: { mistral: { region: "eu" } } }),
      ),
    ).toEqual([]);
  });

  it("never lets a declaration shadow a provider the pack knows", () => {
    const settings = eu({ providers: { tinfoil: { region: "eu" } } });
    expect(resolveProviderTrust("tinfoil", settings.providers).region).toBe("us");
    expect(paths(validatePrivacyConfig(main({}), settings))).toEqual([
      "plugins.entries.privacy-core.config.providers.tinfoil",
    ]);
  });

  it("never lets a declaration make a provider private-safe", () => {
    const issues = validatePrivacyConfig(
      privateConfig({
        agents: {
          defaults: { model: "mistral/mistral-large-latest", sandbox: { mode: "all" } },
          entries: {},
        },
      }),
      privateSettings({ providers: { mistral: { region: "eu" } } }),
    );
    expect(paths(issues)).toEqual(["agents.defaults.model"]);
    expect(issues[0]?.message).toContain("attested=false, region=eu");
  });
});

describe("validatePrivacyConfig: review fixes", () => {
  it("refuses sandbox networks and the sandboxed browser in private mode", () => {
    const issues = validatePrivacyConfig(
      privateConfig({
        agents: {
          defaults: {
            model: "tinfoil/gpt-oss-120b",
            sandbox: { mode: "all", docker: { network: "bridge" }, browser: { enabled: true } },
          },
          entries: {
            browser: {
              skills: [],
              sandbox: { docker: { network: "host" }, browser: { enabled: true } },
            },
          },
        },
      }),
      privateSettings(),
    );
    expect(paths(issues).toSorted()).toEqual(
      [
        "agents.defaults.sandbox.docker.network",
        "agents.defaults.sandbox.browser.enabled",
        "agents.entries.browser.sandbox.docker.network",
        "agents.entries.browser.sandbox.browser.enabled",
      ].toSorted(),
    );
    expect(
      validatePrivacyConfig(
        privateConfig({
          agents: {
            defaults: {
              model: "tinfoil/gpt-oss-120b",
              sandbox: { mode: "all", docker: { network: "none" } },
            },
            entries: {},
          },
        }),
        privateSettings(),
      ),
    ).toEqual([]);
  });

  it("refuses Ollama cloud models, which run on ollama.com", () => {
    const issues = validatePrivacyConfig(
      privateConfig({
        agents: {
          defaults: { model: "ollama/kimi-k2.5:cloud", sandbox: { mode: "all" } },
          entries: {},
        },
        models: { providers: { ollama: { baseUrl: "http://127.0.0.1:11434" } } },
        plugins: {
          allow: ["ollama", "privacy-core"],
          entries: { "privacy-core": { hooks: { allowConversationAccess: true } } },
        },
      }),
      privateSettings(),
    );
    expect(paths(issues)).toEqual(["agents.defaults.model"]);
    expect(issues[0]?.message).toContain("Ollama cloud model");
  });

  it("treats an operator-declared local provider as local only with an explicit loopback URL", () => {
    const local = (baseUrl?: string) =>
      validatePrivacyConfig(
        privateConfig({
          agents: { defaults: { model: "openai/gpt-6", sandbox: { mode: "all" } }, entries: {} },
          ...(baseUrl ? { models: { providers: { openai: { baseUrl } } } } : {}),
        }),
        privateSettings({ providers: { openai: { region: "local" } } }),
      );
    expect(paths(local())).toEqual(["agents.defaults.model"]);
    expect(local()[0]?.message).toContain("set models.providers.openai.baseUrl");
    expect(local("http://127.0.0.1:8080/v1")).toEqual([]);
  });

  it("follows the provider plugin's relay.port", () => {
    const withPort = (baseUrl: string) =>
      privateConfig({
        models: { providers: { tinfoil: { baseUrl } } },
        plugins: {
          allow: ["tinfoil", "a2a", "privacy-core"],
          entries: {
            "privacy-core": { hooks: { allowConversationAccess: true } },
            tinfoil: { config: { relay: { port: 20031 } } },
          },
        },
      });
    expect(validatePrivacyConfig(withPort("http://127.0.0.1:20031/v1"), privateSettings())).toEqual(
      [],
    );
    expect(
      paths(validatePrivacyConfig(withPort("http://127.0.0.1:19931/v1"), privateSettings())),
    ).toEqual(["models.providers.tinfoil.baseUrl"]);
  });

  it("checks every model slot, not only model and utilityModel", () => {
    const issues = validatePrivacyConfig(
      privateConfig({
        agents: {
          defaults: {
            model: "tinfoil/gpt-oss-120b",
            sandbox: { mode: "all" },
            subagents: { model: "openai/gpt-6" },
            compaction: { model: "anthropic/claude-haiku-4-5" },
          } as never,
          entries: { inbox: { skills: [], imageModel: "openai/gpt-image-2" } as never },
        },
      }),
      privateSettings(),
    );
    expect(paths(issues).toSorted()).toEqual(
      [
        "agents.defaults.subagents.model",
        "agents.defaults.compaction.model",
        "agents.entries.inbox.imageModel",
      ].toSorted(),
    );
  });

  it("never hands the proxy an allowlist pattern that failed validation", () => {
    expect(
      resolveEgressAllowlist(privateConfig(), privateSettings({ egress: { allow: ["*.com"] } })),
    ).toEqual(["*.tinfoil.sh", "atc.tinfoil.sh"]);
  });

  it("requires privacy-core to stay enabled", () => {
    const issues = validatePrivacyConfig(
      privateConfig({
        plugins: {
          allow: ["tinfoil", "a2a", "privacy-core"],
          entries: {
            "privacy-core": { enabled: false, hooks: { allowConversationAccess: true } },
          },
        },
      }),
      privateSettings(),
    );
    expect(paths(issues)).toEqual(["plugins.entries.privacy-core.enabled"]);
  });
});

describe("validatePrivacyConfig: skill approval", () => {
  const fingerprint = `sha256:${"a".repeat(64)}`;

  it("refuses a writable sandbox workspace in private mode, where an agent could plant a skill", () => {
    const base = privateConfig();
    const issues = validatePrivacyConfig(
      privateConfig({
        agents: {
          defaults: { ...base.agents?.defaults, sandbox: { mode: "all", workspaceAccess: "rw" } },
          entries: {
            inbox: { skills: [], sandbox: { workspaceAccess: "rw" } },
            reader: { skills: [], sandbox: { workspaceAccess: "ro" } },
          },
        },
      }),
      privateSettings(),
    );
    expect(paths(issues).toSorted()).toEqual([
      "agents.defaults.sandbox.workspaceAccess",
      "agents.entries.inbox.sandbox.workspaceAccess",
    ]);
  });

  it("requires Workshop changes to go through the owner whenever approval is on", () => {
    const standard = { agents: { defaults: { model: "anthropic/claude-opus-5" } } };
    expect(validatePrivacyConfig(standard, resolvePrivacySettings({}))).toEqual([]);
    const required = resolvePrivacySettings({ skills: { approval: "required" } });
    expect(paths(validatePrivacyConfig(standard, required)).toSorted()).toEqual([
      "skills.workshop.approvalPolicy",
      "skills.workshop.autonomous.mode",
    ]);
    expect(
      validatePrivacyConfig(
        {
          ...standard,
          skills: { workshop: { autonomous: { mode: "propose" }, approvalPolicy: "pending" } },
        },
        required,
      ),
    ).toEqual([]);
  });

  it("is always on in private mode and checks the approval format", () => {
    expect(privateSettings({ skills: { approval: "off" } }).skills.approval).toBe("required");
    const settings = privateSettings({
      skills: { approved: { good: [fingerprint], bad: ["sha1:abc"] } },
    });
    expect(paths(validatePrivacyConfig(privateConfig(), settings))).toEqual([
      "plugins.entries.privacy-core.config.skills.approved.bad",
    ]);
  });
});
