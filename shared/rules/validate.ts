import type { PrivacyConfigIssue } from "../audit-types.js";
// Privacy rules for a gateway config, checked by privacy-core at runtime.
//
// A plugin cannot stop a gateway from booting, so an unsafe config is enforced
// differently: every agent run is refused while any issue stands (run gate),
// and on a private gateway all egress goes through privacy-core's allowlisting
// proxy, so nothing leaves the machine if privacy-core is missing. Every issue
// names the exact config key to fix.
import { normalizeHost, PRIVACY_HOSTNAME_RE } from "../hosts.js";
import { egressProxyUrl, type PrivacySettings } from "./settings.js";
import {
  defaultLocalBaseUrl,
  expectedRelayBaseUrl,
  isPackTrustedProvider,
  isRemoteOllamaModel,
  resolveProviderTrust,
} from "./trust.js";

export type { PrivacyConfigIssue } from "../audit-types.js";

type ToolPolicy = { profile?: string; allow?: unknown; alsoAllow?: unknown };

/** The slice of the OpenClaw config these rules read. */
export type HostConfig = {
  tools?: ToolPolicy;
  agents?: {
    defaults?: {
      model?: unknown;
      utilityModel?: unknown;
      imageModel?: unknown;
      models?: Record<string, { agentRuntime?: { id?: string } } | undefined>;
      sandbox?: {
        mode?: string;
        backend?: string;
        workspaceAccess?: string;
        docker?: { network?: string };
        browser?: { allowHostControl?: boolean; enabled?: boolean };
      };
      skills?: unknown;
    };
    entries?: Record<
      string,
      | {
          model?: unknown;
          utilityModel?: unknown;
          models?: Record<string, { agentRuntime?: { id?: string } } | undefined>;
          sandbox?: {
            mode?: string;
            workspaceAccess?: string;
            docker?: { network?: string };
            browser?: { enabled?: boolean };
          };
          skills?: unknown;
          tools?: ToolPolicy;
        }
      | undefined
    >;
  };
  models?: {
    providers?: Record<
      string,
      { baseUrl?: string; apiKey?: unknown; agentRuntime?: { id?: string } } | undefined
    >;
  };
  channels?: Record<string, unknown>;
  plugins?: {
    allow?: string[];
    load?: { paths?: string[] };
    entries?: Record<
      string,
      | { enabled?: boolean; hooks?: { allowConversationAccess?: boolean }; config?: unknown }
      | undefined
    >;
  };
  skills?: {
    load?: { extraDirs?: string[] };
    install?: { allowUploadedArchives?: boolean };
    workshop?: { autonomous?: { mode?: string }; approvalPolicy?: string };
    entries?: Record<string, { enabled?: boolean } | undefined>;
  };
  browser?: { allowSystemProfileImport?: boolean; evaluateEnabled?: boolean };
  logging?: { audit?: { messages?: string } };
  proxy?: { enabled?: boolean; proxyUrl?: string; loopbackMode?: string };
};

/** Plugins a private gateway may run: this pack plus the bundled plugins private agents need. */
export const PRIVATE_MODE_ALLOWED_PLUGINS = new Set([
  "privacy-core",
  "tinfoil",
  "privatemode",
  "a2a",
  "browser",
  "memory-core",
  "ollama",
]);

/** Plugins that must never run inside a private gateway. */
export const PRIVATE_MODE_DENIED_PLUGINS = ["cua-computer", "bonjour", "composio"] as const;

/** The only channel a private gateway may enable: the A2A door to the main gateway. */
export const PRIVATE_MODE_ALLOWED_CHANNELS = new Set(["a2a"]);

/** Agent runtimes that emit the run gate privacy-core relies on. */
const GATED_AGENT_RUNTIMES = new Set(["openclaw", "auto"]);

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

export function isLoopbackUrl(url: string | undefined): boolean {
  if (!url) {
    return false;
  }
  try {
    return LOOPBACK_HOSTS.has(normalizeHost(new URL(url).hostname));
  } catch {
    return false;
  }
}

function parseModelRef(ref: string): { provider: string; model: string } | null {
  const trimmed = ref.trim();
  const slash = trimmed.indexOf("/");
  if (slash <= 0 || slash === trimmed.length - 1) {
    return null;
  }
  return { provider: trimmed.slice(0, slash).toLowerCase(), model: trimmed.slice(slash + 1) };
}

/**
 * Every model ref in the agents config: `model`, `utilityModel`, `imageModel`,
 * `subagents.model`, `compaction.model` and any other key ending in "model",
 * as a string or `{ primary, fallbacks }`. Model catalogs (`models`) are not
 * refs and are skipped; the run gate checks what a run actually uses.
 */
export function collectModelRefs(config: HostConfig): Array<{ path: string; ref: string }> {
  const refs: Array<{ path: string; ref: string }> = [];
  // Only provider/model strings count; bare aliases and embedding names are
  // resolved by their owners, and the run gate checks the provider a run uses.
  const isRef = (value: unknown): value is string =>
    typeof value === "string" && value.trim().includes("/");
  const pushRef = (path: string, value: unknown) => {
    if (isRef(value)) {
      refs.push({ path, ref: value });
      return;
    }
    if (value && typeof value === "object") {
      const record = value as { primary?: unknown; fallbacks?: unknown };
      if (isRef(record.primary)) {
        refs.push({ path: `${path}.primary`, ref: record.primary });
      }
      if (Array.isArray(record.fallbacks)) {
        record.fallbacks.forEach((fallback, index) => {
          if (isRef(fallback)) {
            refs.push({ path: `${path}.fallbacks[${index}]`, ref: fallback });
          }
        });
      }
    }
  };
  const walk = (path: string, node: unknown, depth: number) => {
    if (!node || typeof node !== "object" || Array.isArray(node) || depth > 4) {
      return;
    }
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (key === "models") {
        continue;
      }
      const childPath = `${path}.${key}`;
      if (/model$/iu.test(key)) {
        pushRef(childPath, value);
      } else {
        walk(childPath, value, depth + 1);
      }
    }
  };
  walk("agents.defaults", config.agents?.defaults, 0);
  for (const [agentId, entry] of Object.entries(config.agents?.entries ?? {})) {
    walk(`agents.entries.${agentId}`, entry, 0);
  }
  return refs;
}

/** The primary model ref an agent runs on, or undefined when none is configured. */
export function resolveAgentPrimaryModel(
  config: HostConfig,
  agentId: string | undefined,
): string | undefined {
  const pick = (value: unknown): string | undefined =>
    typeof value === "string" && value.trim()
      ? value.trim()
      : value &&
          typeof value === "object" &&
          typeof (value as { primary?: unknown }).primary === "string"
        ? (value as { primary: string }).primary.trim()
        : undefined;
  return (
    (agentId ? pick(config.agents?.entries?.[agentId]?.model) : undefined) ??
    pick(config.agents?.defaults?.model)
  );
}

function isSecretRefLike(value: unknown): boolean {
  return Boolean(value && typeof value === "object" && "source" in (value as object));
}

const SETTINGS = "plugins.entries.privacy-core.config";

/** Operator region declarations may not shadow a provider this pack already knows. */
function validateOperatorRegions(settings: PrivacySettings): PrivacyConfigIssue[] {
  return Object.keys(settings.providers)
    .filter((id) => isPackTrustedProvider(id))
    .map((id) => ({
      path: `${SETTINGS}.providers.${id}`,
      message: `provider "${id}" is already known to this pack (${resolveProviderTrust(id).region}); remove the override`,
    }));
}

function validateEgressAllow(settings: PrivacySettings): PrivacyConfigIssue[] {
  return settings.egress.allow
    .filter((host) => !PRIVACY_HOSTNAME_RE.test(host))
    .map((host) => ({
      path: `${SETTINGS}.egress.allow`,
      message: `"${host}" is not an exact lowercase hostname (optionally "*.example.com") without scheme, port or path`,
    }));
}

function residencyIssue(
  path: string,
  provider: string,
  trust: ReturnType<typeof resolveProviderTrust>,
  baseUrl: string | undefined,
): PrivacyConfigIssue | null {
  if (trust.region === "eu") {
    return null;
  }
  if (trust.region === "local") {
    return isLoopbackUrl(baseUrl ?? defaultLocalBaseUrl(provider))
      ? null
      : {
          path,
          message: `provider "${provider}" is local but its baseUrl (${baseUrl}) is not loopback; residency is "eu"`,
        };
  }
  const declaredBy =
    trust.source === "operator"
      ? `${SETTINGS}.providers.${provider} declares region "${trust.region}"`
      : trust.source === "pack"
        ? `this pack knows it as region "${trust.region}"`
        : "no region is declared for it";
  const next =
    trust.source === "default"
      ? `confirm the processing region with the vendor, then set ${SETTINGS}.providers.${provider}.region = "eu"`
      : "move the agent to an EU provider";
  return {
    path,
    message: `provider "${provider}" is not EU-resident (${declaredBy}) but residency is "eu"; ${next}`,
  };
}

function validatePrivateMode(config: HostConfig, settings: PrivacySettings): PrivacyConfigIssue[] {
  const issues: PrivacyConfigIssue[] = [];
  const allow = config.plugins?.allow;

  // 1. Model providers: attested through this pack's relay, or a loopback local model.
  const refs = collectModelRefs(config);
  if (!resolveAgentPrimaryModel(config, undefined)) {
    issues.push({
      path: "agents.defaults.model",
      message: `private mode needs an explicit default model; set agents.defaults.model to "${settings.residency === "eu" ? "privatemode" : "tinfoil"}/gpt-oss-120b"`,
    });
  }
  for (const { path, ref } of refs) {
    const parsed = parseModelRef(ref);
    if (!parsed) {
      issues.push({ path, message: `"${ref}" is not a provider/model ref` });
      continue;
    }
    const trust = resolveProviderTrust(parsed.provider, settings.providers);
    const baseUrl = config.models?.providers?.[parsed.provider]?.baseUrl;
    if (trust.attested) {
      const relay = expectedRelayBaseUrl(trust, config.plugins);
      if (baseUrl !== undefined && baseUrl.replace(/\/+$/u, "") !== relay) {
        issues.push({
          path: `models.providers.${parsed.provider}.baseUrl`,
          message: `provider "${parsed.provider}" must go through its attested relay (${relay}); found ${baseUrl}`,
        });
      }
      if (Array.isArray(allow) && trust.pluginId && !allow.includes(trust.pluginId)) {
        issues.push({
          path: "plugins.allow",
          message: `"${ref}" needs the "${trust.pluginId}" plugin in plugins.allow`,
        });
      }
    } else if (trust.region === "local") {
      if (!isLoopbackUrl(baseUrl ?? defaultLocalBaseUrl(parsed.provider))) {
        issues.push({
          path,
          message: baseUrl
            ? `provider "${parsed.provider}" is local but its baseUrl (${baseUrl}) is not loopback`
            : `provider "${parsed.provider}" is declared local; set models.providers.${parsed.provider}.baseUrl to its loopback address`,
        });
        continue;
      }
      if (parsed.provider === "ollama" && isRemoteOllamaModel(parsed.model)) {
        issues.push({
          path,
          message: `"${ref}" is an Ollama cloud model: the daemon sends it to ollama.com. Use a model that runs on this machine`,
        });
        continue;
      }
    } else {
      issues.push({
        path,
        message:
          `provider "${parsed.provider}" is not allowed in private mode (attested=false, region=${trust.region}). ` +
          "Private agents may only use attested providers (tinfoil, privatemode) or a loopback Ollama.",
      });
      continue;
    }
    if (settings.residency === "eu") {
      const issue = residencyIssue(path, parsed.provider, trust, baseUrl);
      if (issue) {
        issues.push(issue);
      }
    }
  }

  // 2. Only the embedded OpenClaw runtime emits the run gate; external harnesses do not.
  const runtimeIssue = (path: string, id: string | undefined) => {
    if (id !== undefined && !GATED_AGENT_RUNTIMES.has(id)) {
      issues.push({
        path,
        message: `private mode requires the OpenClaw agent runtime; "${id}" bypasses the privacy run gate`,
      });
    }
  };
  for (const [id, provider] of Object.entries(config.models?.providers ?? {})) {
    runtimeIssue(`models.providers.${id}.agentRuntime.id`, provider?.agentRuntime?.id);
  }
  for (const [ref, entry] of Object.entries(config.agents?.defaults?.models ?? {})) {
    runtimeIssue(`agents.defaults.models.${ref}.agentRuntime.id`, entry?.agentRuntime?.id);
  }
  for (const [agentId, agent] of Object.entries(config.agents?.entries ?? {})) {
    for (const [ref, entry] of Object.entries(agent?.models ?? {})) {
      runtimeIssue(
        `agents.entries.${agentId}.models.${ref}.agentRuntime.id`,
        entry?.agentRuntime?.id,
      );
    }
  }

  // 3. Plaintext provider keys are refused; SecretRefs are required.
  for (const [providerId, providerConfig] of Object.entries(config.models?.providers ?? {})) {
    const apiKey = providerConfig?.apiKey;
    if (typeof apiKey === "string" && apiKey.trim() && !isSecretRefLike(apiKey)) {
      issues.push({
        path: `models.providers.${providerId}.apiKey`,
        message:
          "private mode refuses plaintext provider keys; use a SecretRef (store, exec, file)",
      });
    }
  }

  // 4. Sandbox: on for every agent, or, in lite mode (no Docker), no agent may
  // have a tool that runs commands or touches files.
  if (settings.sandbox === "required") {
    const sandbox = config.agents?.defaults?.sandbox;
    if (sandbox?.mode !== "all") {
      issues.push({
        path: "agents.defaults.sandbox.mode",
        message: `private mode requires agents.defaults.sandbox.mode = "all" (found ${JSON.stringify(sandbox?.mode ?? "off")})`,
      });
    }
    const backend = sandbox?.backend ?? "docker";
    if (backend !== "docker" && backend !== "podman") {
      issues.push({
        path: "agents.defaults.sandbox.backend",
        message: `private mode supports only the docker or podman sandbox backend (found "${backend}")`,
      });
    }
    if (sandbox?.browser?.allowHostControl === true) {
      issues.push({
        path: "agents.defaults.sandbox.browser.allowHostControl",
        message: "private mode forbids host browser control",
      });
    }
    // Containers do not inherit the gateway's proxy, so their network must stay off.
    const networkIssue = (path: string, network: string | undefined) => {
      if (network !== undefined && network !== "none") {
        issues.push({
          path,
          message: `private mode requires sandbox network "none" (found "${network}"); a container network bypasses the egress proxy`,
        });
      }
    };
    const browserIssue = (path: string, enabled: boolean | undefined) => {
      if (enabled === true) {
        issues.push({
          path,
          message:
            "the sandboxed browser has its own network that bypasses the egress proxy; it is not available in private mode yet",
        });
      }
    };
    // A writable workspace lets an agent plant a skill that loads on its next run.
    const workspaceAccessIssue = (path: string, access: string | undefined) => {
      if (access === "rw") {
        issues.push({
          path,
          message:
            'private mode forbids sandbox workspaceAccess "rw"; use "none" (default) or "ro" so an agent cannot write its own skills',
        });
      }
    };
    workspaceAccessIssue("agents.defaults.sandbox.workspaceAccess", sandbox?.workspaceAccess);
    networkIssue("agents.defaults.sandbox.docker.network", sandbox?.docker?.network);
    browserIssue("agents.defaults.sandbox.browser.enabled", sandbox?.browser?.enabled);
    for (const [agentId, entry] of Object.entries(config.agents?.entries ?? {})) {
      const mode = entry?.sandbox?.mode;
      if (mode !== undefined && mode !== "all") {
        issues.push({
          path: `agents.entries.${agentId}.sandbox.mode`,
          message: `private mode forbids per-agent sandbox mode "${mode}"; remove it or set "all"`,
        });
      }
      workspaceAccessIssue(
        `agents.entries.${agentId}.sandbox.workspaceAccess`,
        entry?.sandbox?.workspaceAccess,
      );
      networkIssue(
        `agents.entries.${agentId}.sandbox.docker.network`,
        entry?.sandbox?.docker?.network,
      );
      browserIssue(
        `agents.entries.${agentId}.sandbox.browser.enabled`,
        entry?.sandbox?.browser?.enabled,
      );
    }
  } else {
    issues.push(...validateLiteTools(config));
  }
  for (const [agentId, entry] of Object.entries(config.agents?.entries ?? {})) {
    if (!Array.isArray(entry?.skills)) {
      issues.push({
        path: `agents.entries.${agentId}.skills`,
        message:
          "private mode requires an explicit skills allowlist on every agent (an empty array is allowed)",
      });
    }
  }

  // 5. Channels: only the A2A door.
  for (const [channelId, channelConfig] of Object.entries(config.channels ?? {})) {
    if (PRIVATE_MODE_ALLOWED_CHANNELS.has(channelId)) {
      continue;
    }
    if ((channelConfig as { enabled?: unknown } | undefined)?.enabled !== false) {
      issues.push({
        path: `channels.${channelId}`,
        message:
          "private mode allows only the a2a channel; remove this channel or set enabled: false. " +
          "User-facing channels belong to the main (standard) gateway.",
      });
    }
  }

  // 6. Plugins: an explicit allowlist drawn from a fixed set; nothing else loads.
  if (!Array.isArray(allow) || allow.length === 0) {
    issues.push({
      path: "plugins.allow",
      message: "private mode requires an explicit plugins.allow list",
    });
  } else {
    for (const pluginId of allow) {
      if (!PRIVATE_MODE_ALLOWED_PLUGINS.has(pluginId)) {
        issues.push({
          path: "plugins.allow",
          message: `plugin "${pluginId}" is not allowed in private mode; allowed: ${[...PRIVATE_MODE_ALLOWED_PLUGINS].join(", ")}`,
        });
      }
    }
    if (config.plugins?.entries?.["privacy-core"]?.enabled === false) {
      issues.push({
        path: "plugins.entries.privacy-core.enabled",
        message: "private mode requires privacy-core to be enabled",
      });
    }
    if (!allow.includes("privacy-core")) {
      issues.push({
        path: "plugins.allow",
        message: 'private mode requires "privacy-core" in plugins.allow',
      });
    }
  }
  for (const denied of PRIVATE_MODE_DENIED_PLUGINS) {
    if (config.plugins?.entries?.[denied]?.enabled === true) {
      issues.push({
        path: `plugins.entries.${denied}.enabled`,
        message: `plugin "${denied}" is not allowed in private mode`,
      });
    }
  }
  if (config.plugins?.entries?.["privacy-core"]?.hooks?.allowConversationAccess !== true) {
    issues.push({
      path: "plugins.entries.privacy-core.hooks.allowConversationAccess",
      message: "set to true so privacy-core can gate agent runs and pin attested models",
    });
  }
  if ((config.skills?.load?.extraDirs ?? []).length > 0) {
    issues.push({
      path: "skills.load.extraDirs",
      message: "private mode forbids extra skill directories; bundled and workspace skills only",
    });
  }
  if (config.skills?.install?.allowUploadedArchives === true) {
    issues.push({
      path: "skills.install.allowUploadedArchives",
      message: "private mode forbids installing uploaded skill archives",
    });
  }

  // 7. Egress: every outbound connection goes through privacy-core's allowlisting proxy.
  const expectedProxy = egressProxyUrl(settings.egress.proxyPort);
  if (
    config.proxy?.proxyUrl?.replace(/\/+$/u, "") !== expectedProxy ||
    config.proxy?.enabled === false
  ) {
    issues.push({
      path: "proxy.proxyUrl",
      message: `private mode routes all egress through privacy-core; set proxy.proxyUrl to "${expectedProxy}"`,
    });
  }
  if (config.proxy?.loopbackMode === "proxy") {
    issues.push({
      path: "proxy.loopbackMode",
      message:
        'use "gateway-only" (default) or "block"; "proxy" sends the relays\' loopback traffic to the proxy',
    });
  }

  // 8. Settings that copy local data somewhere it should not go.
  if (config.browser?.allowSystemProfileImport === true) {
    issues.push({
      path: "browser.allowSystemProfileImport",
      message: "private mode forbids importing the host browser profile",
    });
  }
  if (config.browser?.evaluateEnabled !== false) {
    issues.push({
      path: "browser.evaluateEnabled",
      message: "private mode requires browser.evaluateEnabled = false",
    });
  }
  const auditMessages = config.logging?.audit?.messages;
  if (auditMessages && auditMessages !== "off") {
    issues.push({
      path: "logging.audit.messages",
      message: 'private mode requires logging.audit.messages = "off"',
    });
  }
  return issues;
}

/**
 * The only tools a lite-mode private agent may add to OpenClaw's `minimal`
 * profile. Without a sandbox every tool runs on this computer directly, so
 * lite mode lists what is allowed rather than what is not: a new OpenClaw
 * tool, an alias (`cron`, `apply-patch`) or an MCP tool is refused until it
 * is added here.
 */
export const LITE_ALLOWED_TOOLS = new Set([
  "group:memory",
  "memory_get",
  "memory_search",
  "session_status",
]);

/** Tools the `minimal` profile itself includes that a lite agent must deny. */
export const LITE_REQUIRED_DENY = ["gateway"];

type ToolPolicyWithDeny = ToolPolicy & { deny?: unknown };

function validateLiteTools(config: HostConfig): PrivacyConfigIssue[] {
  const issues: PrivacyConfigIssue[] = [];
  const normalize = (tool: unknown) => (typeof tool === "string" ? tool.trim().toLowerCase() : "");
  const checkAllow = (path: string, policy: ToolPolicy | undefined) => {
    for (const key of ["allow", "alsoAllow"] as const) {
      const list = policy?.[key];
      if (list === undefined) {
        continue;
      }
      const bad = (Array.isArray(list) ? list : [list]).filter(
        (tool) => !LITE_ALLOWED_TOOLS.has(normalize(tool)),
      );
      if (bad.length > 0) {
        issues.push({
          path: `${path}.${key}`,
          message: `lite mode (no sandbox) allows only ${[...LITE_ALLOWED_TOOLS].join(", ")}; remove ${bad.map((tool) => JSON.stringify(tool)).join(", ")}, which would run on this computer directly, or install Docker and set sandbox: "required"`,
        });
      }
    }
  };
  const denies = (policy: ToolPolicy | undefined) => {
    const list = (policy as ToolPolicyWithDeny | undefined)?.deny;
    return Array.isArray(list) ? list.map(normalize) : [];
  };
  checkAllow("tools", config.tools);
  const globalDeny = denies(config.tools);
  const entries = Object.entries(config.agents?.entries ?? {});
  for (const [agentId, entry] of entries) {
    const path = `agents.entries.${agentId}.tools`;
    const profile = entry?.tools?.profile ?? config.tools?.profile;
    if (profile !== "minimal") {
      issues.push({
        path: `${path}.profile`,
        message: `lite mode (no sandbox) requires tools.profile "minimal" (found ${JSON.stringify(profile ?? "unset")}), so the agent has no shell or file tools`,
      });
    }
    checkAllow(path, entry?.tools);
    const deny = new Set([...globalDeny, ...denies(entry?.tools)]);
    const missing = LITE_REQUIRED_DENY.filter((tool) => !deny.has(tool) && !deny.has("*"));
    if (missing.length > 0) {
      issues.push({
        path: `${path}.deny`,
        message: `lite mode (no sandbox) requires tools.deny to include ${missing.join(", ")}, which the minimal profile otherwise grants`,
      });
    }
  }
  return issues;
}

/** Matches a fingerprint written by `privacy skills approve`. */
export const SKILL_FINGERPRINT_RE = /^sha256:[0-9a-f]{64}$/u;

/**
 * Rules that keep skill approval meaningful. Skill Workshop's defaults let an
 * agent write and apply its own skills; with approval required, every such
 * edit would refuse the agent's next run, so the config must route Workshop
 * changes through the operator instead.
 */
function validateSkillApproval(
  config: HostConfig,
  settings: PrivacySettings,
): PrivacyConfigIssue[] {
  if (settings.skills.approval !== "required") {
    return [];
  }
  const issues: PrivacyConfigIssue[] = [];
  const workshop = config.skills?.workshop;
  const autonomous = workshop?.autonomous?.mode ?? "auto";
  if (autonomous !== "off" && autonomous !== "propose") {
    issues.push({
      path: "skills.workshop.autonomous.mode",
      message: `skill approval requires "off" or "propose" (found "${autonomous}"); in "auto" the agent edits its own skills without review`,
    });
  }
  const approvalPolicy = workshop?.approvalPolicy ?? "auto";
  if (approvalPolicy !== "pending") {
    issues.push({
      path: "skills.workshop.approvalPolicy",
      message: `skill approval requires "pending" (found "${approvalPolicy}") so the agent cannot apply its own skill proposals`,
    });
  }
  for (const [name, fingerprints] of Object.entries(settings.skills.approved)) {
    if (!fingerprints.every((fingerprint) => SKILL_FINGERPRINT_RE.test(fingerprint))) {
      issues.push({
        path: `plugins.entries.privacy-core.config.skills.approved.${name}`,
        message:
          "every approval must be a sha256:<hex> fingerprint; use openclaw privacy skills approve",
      });
    }
  }
  return issues;
}

function validateStandardResidency(
  config: HostConfig,
  settings: PrivacySettings,
): PrivacyConfigIssue[] {
  if (settings.residency !== "eu") {
    return [];
  }
  const issues: PrivacyConfigIssue[] = [];
  for (const { path, ref } of collectModelRefs(config)) {
    const parsed = parseModelRef(ref);
    if (!parsed) {
      issues.push({ path, message: `"${ref}" is not a provider/model ref` });
      continue;
    }
    const issue = residencyIssue(
      path,
      parsed.provider,
      resolveProviderTrust(parsed.provider, settings.providers),
      config.models?.providers?.[parsed.provider]?.baseUrl,
    );
    if (issue) {
      issues.push(issue);
    }
  }
  return issues;
}

/** Every privacy rule for this gateway. Empty means the config is safe for its mode. */
export function validatePrivacyConfig(
  config: HostConfig,
  settings: PrivacySettings,
): PrivacyConfigIssue[] {
  const issues = [
    ...validateOperatorRegions(settings),
    ...validateEgressAllow(settings),
    ...(settings.mode === "private"
      ? validatePrivateMode(config, settings)
      : validateStandardResidency(config, settings)),
    ...validateSkillApproval(config, settings),
  ];
  // One provider block is reported once, however many agents use it.
  const seen = new Set<string>();
  return issues.filter((issue) => {
    const key = `${issue.path}\n${issue.message}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

/** Hosts a private gateway may reach: the attested providers in use plus the operator's list. */
export function resolveEgressAllowlist(config: HostConfig, settings: PrivacySettings): string[] {
  // Patterns that fail validation never reach the proxy.
  const hosts = new Set<string>(
    settings.egress.allow.filter((host) => PRIVACY_HOSTNAME_RE.test(host)),
  );
  for (const { ref } of collectModelRefs(config)) {
    const parsed = parseModelRef(ref);
    if (!parsed) {
      continue;
    }
    for (const host of resolveProviderTrust(parsed.provider, settings.providers).egressHosts ??
      []) {
      hosts.add(host);
    }
  }
  return [...hosts].toSorted();
}

export function formatPrivacyConfigIssues(issues: PrivacyConfigIssue[]): string {
  return issues.map((issue) => `- ${issue.path}: ${issue.message}`).join("\n");
}
