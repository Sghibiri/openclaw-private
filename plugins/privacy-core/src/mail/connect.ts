// `openclaw privacy mail connect | disconnect`: what changes on the private
// gateway, as plain steps with injected effects so it can be tested. The CLI
// in mail-cli.ts asks the questions and supplies the real effects.
import { MAIL_SECRET_IDS, MAIL_TOOL_NAMES, type MailProviderId } from "../../../../shared/mail.js";
import type { RunResult } from "../setup/run.js";

type Env = Record<string, string | undefined>;

export type MailCliDeps = {
  /** Runs `openclaw --profile private <args>` with an environment free of secrets. */
  openclawPrivate: (args: string[], input?: string) => Promise<RunResult>;
  privateConfigPath: string;
  readFile: (file: string) => Promise<string | undefined>;
  writeFileAtomic: (file: string, content: string) => Promise<void>;
  log: (line: string) => void;
};

export type MailConnectAnswers = {
  provider: MailProviderId;
  address: string;
  password: string;
  calendarUrl?: string;
};

type AgentEntry = {
  tools?: { alsoAllow?: unknown; sandbox?: { tools?: { alsoAllow?: unknown } } };
};
type PrivateConfig = {
  agents?: { defaults?: { sandbox?: { mode?: unknown } }; entries?: Record<string, AgentEntry> };
  plugins?: { entries?: Record<string, { config?: Record<string, unknown> } | undefined> };
};

const storeRef = (id: string) => ({ source: "store", provider: "default", id });
const lastLine = (result: RunResult) =>
  (result.stderr || result.stdout).trim().split("\n").slice(-1)[0] ?? "";

async function readPrivateConfig(deps: MailCliDeps): Promise<PrivateConfig> {
  const raw = await deps.readFile(deps.privateConfigPath);
  if (raw === undefined) {
    throw new Error(
      `there is no private gateway yet (${deps.privateConfigPath} is missing); run: openclaw privacy setup`,
    );
  }
  try {
    return JSON.parse(raw) as PrivateConfig;
  } catch {
    throw new Error(`${deps.privateConfigPath} is not plain JSON, so it cannot be changed safely`);
  }
}

function addTools(list: unknown, names: readonly string[]): string[] {
  const current = Array.isArray(list)
    ? list.filter((item): item is string => typeof item === "string")
    : [];
  return [...current, ...names.filter((name) => !current.includes(name))];
}

function removeTools(list: unknown, names: readonly string[]): string[] {
  return (Array.isArray(list) ? list : []).filter(
    (item): item is string => typeof item === "string" && !names.includes(item),
  );
}

/** The Inbox agent gets the mail tools; in full mode its sandbox must let them through too. */
function setInboxTools(config: PrivateConfig, connect: boolean): boolean {
  const inbox = config.agents?.entries?.inbox;
  if (!inbox) {
    return false;
  }
  const change = connect ? addTools : removeTools;
  inbox.tools ??= {};
  inbox.tools.alsoAllow = change(inbox.tools.alsoAllow, MAIL_TOOL_NAMES);
  if (config.agents?.defaults?.sandbox?.mode !== "off") {
    inbox.tools.sandbox ??= {};
    inbox.tools.sandbox.tools ??= {};
    inbox.tools.sandbox.tools.alsoAllow = change(
      inbox.tools.sandbox.tools.alsoAllow,
      MAIL_TOOL_NAMES,
    );
  }
  return true;
}

function privacyCoreConfig(config: PrivateConfig): Record<string, unknown> {
  config.plugins ??= {};
  config.plugins.entries ??= {};
  const entry = (config.plugins.entries["privacy-core"] ??= {});
  return (entry.config ??= {});
}

async function restartAndVerify(deps: MailCliDeps): Promise<string[]> {
  const warnings: string[] = [];
  const restart = await deps.openclawPrivate(["gateway", "restart"]);
  if (restart.code !== 0) {
    warnings.push(
      `could not restart the private gateway (${lastLine(restart)}); run: openclaw --profile private gateway restart`,
    );
  }
  const status = await deps.openclawPrivate(["privacy", "status", "--json"]);
  const start = status.stdout.indexOf("{");
  let issues: Array<{ path: string; message: string }> | undefined;
  try {
    issues = (JSON.parse(status.stdout.slice(start)) as { issues?: typeof issues }).issues;
  } catch {
    issues = undefined;
  }
  if (!issues) {
    warnings.push(
      "could not read the private gateway's status; check: openclaw --profile private privacy status",
    );
  } else if (issues.length > 0) {
    warnings.push(
      `the private config has ${issues.length} problem(s): ${issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ")}`,
    );
  }
  return warnings;
}

export async function connectMail(
  answers: MailConnectAnswers,
  deps: MailCliDeps,
): Promise<{ warnings: string[] }> {
  const config = await readPrivateConfig(deps);
  const stored = await deps.openclawPrivate(
    ["secrets", "store", "set", MAIL_SECRET_IDS.password, "--kind", "secret"],
    answers.password,
  );
  if (stored.code !== 0) {
    throw new Error(`storing the app password failed: ${lastLine(stored)}`);
  }
  deps.log(`  ok  stored the app password in the private gateway's secret store`);
  if (answers.calendarUrl) {
    const storedUrl = await deps.openclawPrivate(
      ["secrets", "store", "set", MAIL_SECRET_IDS.calendarUrl, "--kind", "secret"],
      answers.calendarUrl,
    );
    if (storedUrl.code !== 0) {
      throw new Error(`storing the calendar link failed: ${lastLine(storedUrl)}`);
    }
    deps.log(`  ok  stored the calendar link in the private gateway's secret store`);
  }
  privacyCoreConfig(config).mail = {
    provider: answers.provider,
    address: answers.address,
    password: storeRef(MAIL_SECRET_IDS.password),
    ...(answers.calendarUrl ? { calendarUrl: storeRef(MAIL_SECRET_IDS.calendarUrl) } : {}),
  };
  const warnings: string[] = [];
  if (!setInboxTools(config, true)) {
    warnings.push(
      `the private config has no "inbox" agent; allow ${MAIL_TOOL_NAMES.join(", ")} in the tools of the agent that should read mail`,
    );
  }
  await deps.writeFileAtomic(deps.privateConfigPath, `${JSON.stringify(config, null, 2)}\n`);
  deps.log(`  ok  connected ${answers.address} to the private Inbox agent (read-only)`);
  return { warnings: [...warnings, ...(await restartAndVerify(deps))] };
}

export async function disconnectMail(deps: MailCliDeps): Promise<{ warnings: string[] }> {
  const config = await readPrivateConfig(deps);
  const core = privacyCoreConfig(config);
  const hadCalendar =
    (core.mail as { calendarUrl?: unknown } | undefined)?.calendarUrl !== undefined;
  delete core.mail;
  setInboxTools(config, false);
  await deps.writeFileAtomic(deps.privateConfigPath, `${JSON.stringify(config, null, 2)}\n`);
  deps.log("  ok  removed the mail connector from the private gateway");
  const warnings: string[] = [];
  // `rm` asks for confirmation unless --yes; this command was the confirmation.
  const remove = async (id: string, what: string) => {
    const removed = await deps.openclawPrivate(["secrets", "store", "rm", id, "--yes"]);
    if (removed.code === 0) {
      deps.log(`  ok  deleted the ${what} from the secret store`);
    } else {
      warnings.push(
        `could not delete the stored ${what} (${lastLine(removed)}); run: openclaw --profile private secrets store rm ${id} --yes`,
      );
    }
  };
  await remove(MAIL_SECRET_IDS.password, "app password");
  if (hadCalendar) {
    await remove(MAIL_SECRET_IDS.calendarUrl, "calendar link");
  }
  return { warnings: [...warnings, ...(await restartAndVerify(deps))] };
}

export function describeMailConnection(raw: string | undefined): string {
  if (raw === undefined) {
    return "No private gateway yet; run: openclaw privacy setup";
  }
  try {
    const mail = (JSON.parse(raw) as PrivateConfig).plugins?.entries?.["privacy-core"]?.config
      ?.mail as { provider?: string; address?: string; calendarUrl?: unknown } | undefined;
    if (!mail) {
      return "Mail: not connected. Connect with: openclaw privacy mail connect";
    }
    return `Mail: ${mail.address} (${mail.provider}), read-only; calendar: ${mail.calendarUrl ? "connected" : "not connected"}`;
  } catch {
    return "The private config is not plain JSON; cannot tell.";
  }
}

export type { Env };
