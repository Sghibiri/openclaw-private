import { spawn } from "node:child_process";
// `openclaw privacy setup`: one guided command that turns a fresh OpenClaw
// install into the two-gateway setup. It asks two questions (which private
// model, and its key), shows what it will do, then does it.
import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { resolveRequiredHomeDir, resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import {
  DEFAULT_PRIVATE_PORT,
  PRIVATE_PROFILE,
  packageSpecs,
  planSetup,
  PROVIDERS,
  type PrivateProvider,
  type SetupAnswers,
  type SetupStep,
} from "./plan.js";
import { runSetup, type RunResult, type SetupDeps } from "./run.js";

type CliProgram = Parameters<Parameters<OpenClawPluginApi["registerCli"]>[0]>[0]["program"];
type PrivacyCommand = ReturnType<CliProgram["command"]>;

type SetupOptions = {
  provider?: string;
  keyEnv?: string;
  port?: string;
  yes?: boolean;
  dryRun?: boolean;
  overwrite?: boolean;
  from?: string;
  lite?: boolean;
};

export function runProcess(
  command: string,
  args: string[],
  options: { input?: string; env: Record<string, string | undefined>; timeoutMs?: number },
): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: options.env as NodeJS.ProcessEnv,
      // Its own process group, so a time limit also stops what it started (npm).
      detached: options.timeoutMs !== undefined,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer =
      options.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            try {
              process.kill(-(child.pid ?? 0), "SIGTERM");
            } catch {
              child.kill("SIGTERM");
            }
          }, options.timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: 127, stdout, stderr: error.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        const ms = options.timeoutMs ?? 0;
        const limit =
          ms >= 60_000 ? `${Math.round(ms / 60_000)} minutes` : `${Math.round(ms / 1000)} seconds`;
        // What it printed last is what it was waiting on.
        resolve({
          code: 124,
          stdout,
          stderr: `no result after ${limit}, so it was stopped. Its last output: ${stderr.trim().split("\n").slice(-2).join(" / ") || stdout.trim().split("\n").slice(-2).join(" / ") || "(none)"}. Check the internet connection (curl -I https://registry.npmjs.org), then run setup again.`,
        });
        return;
      }
      resolve({ code: code ?? 1, stdout, stderr });
    });
    child.stdin.end(options.input ?? "");
  });
}

/**
 * One chunk of typed or pasted input for a hidden prompt: what to keep, and
 * what to echo (a star per character, so a paste visibly arrived).
 */
export function hiddenInputStep(
  value: string,
  chunk: string,
): { value: string; echo: string; done: boolean; cancelled: boolean } {
  let echo = "";
  // Terminals wrap a paste in bracketed-paste markers; they are not part of the key.
  const text = chunk.replace(/\u001b\[20[01]~/gu, "");
  for (const char of text) {
    if (char === "\r" || char === "\n") {
      return { value, echo, done: true, cancelled: false };
    }
    if (char === "\u0003") {
      return { value, echo, done: true, cancelled: true };
    }
    if (char === "\u007f" || char === "\b") {
      if (value.length > 0) {
        value = value.slice(0, -1);
        echo += "\b \b";
      }
      continue;
    }
    if (char < " ") {
      continue;
    }
    value += char;
    echo += "*";
  }
  return { value, echo, done: false, cancelled: false };
}

function askHidden(question: string): Promise<string> {
  const stdin = process.stdin;
  process.stdout.write(question);
  return new Promise((resolve, reject) => {
    let value = "";
    const finish = (error?: Error) => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stdout.write("\n");
      if (error) {
        reject(error);
      } else {
        resolve(value.trim());
      }
    };
    const onData = (data: Buffer) => {
      const step = hiddenInputStep(value, data.toString("utf8"));
      value = step.value;
      process.stdout.write(step.echo);
      if (step.done) {
        finish(step.cancelled ? new Error("Cancelled; nothing was changed.") : undefined);
      }
    };
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
  });
}

async function ask(question: string, hidden = false): Promise<string> {
  if (hidden && process.stdin.isTTY) {
    return askHidden(question);
  }
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/**
 * A one-line spinner with elapsed seconds for the step that is running, so
 * a slow download never looks frozen. Lines logged meanwhile print above it.
 */
function createSpinner(write: (text: string) => void) {
  let line: string | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  const clear = () => {
    if (line !== undefined) {
      write("\r\u001b[2K");
    }
  };
  return {
    start(label: string): () => void {
      const started = Date.now();
      let frame = 0;
      const draw = () => {
        const seconds = Math.floor((Date.now() - started) / 1000);
        line = `  ${SPINNER[frame++ % SPINNER.length]}  ${label}${seconds >= 2 ? ` (${seconds}s)` : ""}`;
        write(`\r\u001b[2K${line}`);
      };
      draw();
      timer = setInterval(draw, 100);
      return () => {
        clearInterval(timer);
        clear();
        line = undefined;
      };
    },
    log(text: string, print: (text: string) => void) {
      clear();
      print(text);
      if (line !== undefined) {
        write(line);
      }
    },
  };
}

function describe(step: SetupStep): string {
  switch (step.kind) {
    case "check-docker":
      return "check that Docker is running";
    case "build-sandbox-image":
      return "build the sandbox image private agents run their tools in";
    case "store-secret":
      return `store ${step.name} in the ${step.profile} gateway's secret store`;
    case "write-env":
      return `set the door tokens in the ${step.profile} gateway's .env (${step.names.join(", ")}); existing ones are kept`;
    case "write-private-config":
      return "write the private gateway's config (one Inbox agent behind the door)";
    case "pause-egress-proxy":
      return "pause the private gateway's egress proxy so its plugins can download";
    case "install-plugin":
      return `install ${step.spec} on the private gateway`;
    case "resume-egress-proxy":
      return "turn the egress proxy back on";
    case "update-main-config":
      return "connect your main gateway to the private one (the door)";
    case "install-private-service":
      return "install the private gateway as a background service";
    case "restart-main-gateway":
      return "restart the main gateway";
    case "verify":
      return "check the private gateway's privacy status";
    case "check-door":
      return "check that the door to the private gateway opens with its token";
  }
}

export async function runPrivacySetup(
  opts: SetupOptions,
  context: { packVersion: string; log?: (line: string) => void },
): Promise<boolean> {
  const log = context.log ?? ((line: string) => console.log(line));
  const terminal = Boolean(process.stdin.isTTY);
  const interactive = terminal && !opts.yes;
  if (!terminal && !opts.yes && !opts.dryRun) {
    log("Run openclaw privacy setup in a terminal, or add --yes to run it without questions.");
    return false;
  }
  log("OpenClaw Private setup");
  log(
    "Your main gateway stays as it is. A second, private gateway is added for agents that read your email or documents; they may only use a model in a verified hardware enclave.\n",
  );

  let provider = opts.provider as PrivateProvider | undefined;
  if (!provider && interactive) {
    log(
      `Which private model service?\n  1) ${PROVIDERS.tinfoil.label}\n  2) ${PROVIDERS.privatemode.label}`,
    );
    provider = (await ask("Choose 1 or 2: ")) === "2" ? "privatemode" : "tinfoil";
  }
  if (provider !== "tinfoil" && provider !== "privatemode") {
    log("Choose the private model service with --provider tinfoil or --provider privatemode.");
    return false;
  }
  // Before the key, so choosing to install Docker first loses nothing typed.
  let lite = opts.lite === true;
  if (!lite) {
    const docker = await runProcess("docker", ["info", "--format", "{{.ServerVersion}}"], {
      env: { ...process.env },
    });
    if (docker.code !== 0 && interactive) {
      log(
        "\nDocker is not running on this computer. Private agents normally run their tools inside a Docker container, so a bad email or document cannot reach your files.\n  1) Stop here and install OrbStack first (recommended, free for personal use): https://orbstack.dev\n  2) Continue in lite mode: the private agent can chat and remember, but gets no shell, file or browser tools. You can switch to full mode later.",
      );
      if ((await ask("Choose 1 or 2: ")) !== "2") {
        log(
          "Nothing was changed. Install OrbStack, open it once, then run: openclaw privacy setup",
        );
        return false;
      }
      lite = true;
    }
  }
  const template = PROVIDERS[provider];
  let providerKey = opts.keyEnv ? (process.env[opts.keyEnv] ?? "").trim() : "";
  if (!providerKey && !opts.dryRun) {
    if (!interactive) {
      log(`Pass the ${template.keyName} with --key-env <VARIABLE>, or run this in a terminal.`);
      return false;
    }
    log(template.keyHelp);
    log("Paste it once and press Enter; each character shows as *.");
    providerKey = await ask(`Paste your ${template.keyName} (hidden): `, true);
    if (!providerKey) {
      log("No key given; nothing was changed.");
      return false;
    }
    log(`Key received (${providerKey.length} characters).`);
  }
  const port = opts.port ? Number(opts.port) : DEFAULT_PRIVATE_PORT;
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    log(`--port must be a whole number from 1024 to 65535 (got "${opts.port}").`);
    return false;
  }
  const local = opts.from ? path.resolve(opts.from) : undefined;
  const answers: SetupAnswers = {
    provider,
    privatePort: port,
    packVersion: context.packVersion,
    // `--from` takes `npm pack` tarballs, which install exactly like npm.
    packages: local
      ? {
          core: `npm-pack:${path.join(local, `openclaw-private-${context.packVersion}.tgz`)}`,
          provider: `npm-pack:${path.join(local, `openclaw-private-${provider}-${context.packVersion}.tgz`)}`,
        }
      : packageSpecs(provider, context.packVersion),
    ...(lite ? { lite: true } : {}),
  };
  const steps = planSetup(answers);
  if (lite) {
    log("\nLite mode: no Docker needed. The private agent gets no shell, file or browser tools.");
  }
  log("\nThis will:");
  steps.forEach((step, index) => log(`  ${index + 1}. ${describe(step)}`));
  if (opts.dryRun) {
    log("\nDry run: nothing was changed.");
    return true;
  }
  if (interactive && (await ask("\nGo ahead? Type yes: ")).toLowerCase() !== "yes") {
    log("Nothing was changed.");
    return false;
  }
  log("");
  // The same home OpenClaw resolves profiles under (OPENCLAW_HOME, then the OS home).
  const privateStateDir = path.join(resolveRequiredHomeDir(), `.openclaw-${PRIVATE_PROFILE}`);
  const spinner = terminal ? createSpinner((text) => process.stdout.write(text)) : undefined;
  const deps: SetupDeps = {
    ...(spinner
      ? {
          progress: (step: SetupStep, index: number, total: number) =>
            spinner.start(`[${index}/${total}] ${describe(step)}`),
        }
      : {}),
    run: runProcess,
    openclaw: { command: process.execPath, args: process.argv[1] ? [process.argv[1]] : [] },
    env: { ...process.env },
    privateStateDir,
    mainEnvFile: path.join(resolveStateDir(), ".env"),
    readFile: async (file) => readFile(file, "utf8").catch(() => undefined),
    fileExists: async (file) =>
      stat(file).then(
        () => true,
        () => false,
      ),
    writeFileAtomic: async (file, content) => {
      await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      // Owner-only from the first byte, then swapped in: never a half-written or readable file.
      const temp = `${file}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
      await writeFile(temp, content, { mode: 0o600, flag: "wx" });
      await rename(temp, file);
    },
    rename,
    mutateMainConfig: async (mutate) => {
      const { mutateConfigFile } = await import("openclaw/plugin-sdk/config-mutation");
      const result = await mutateConfigFile<string[]>({
        mutate: (draft) => mutate(draft as unknown as Record<string, unknown>),
      });
      return result.result ?? [];
    },
    probeDoor: async (url, token) => {
      try {
        const response = await fetch(url, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tasks/get",
            params: { id: "setup-check" },
          }),
          signal: AbortSignal.timeout(5000),
        });
        return response.status;
      } catch {
        return 0;
      }
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    randomToken: () => randomBytes(32).toString("hex"),
    log: spinner ? (line) => spinner.log(line, log) : log,
  };
  const outcome = await runSetup({
    steps,
    answers,
    providerKey,
    ...(opts.overwrite ? { overwrite: true } : {}),
    ...(opts.keyEnv ? { secretEnvNames: [opts.keyEnv] } : {}),
    deps,
  });
  if (!outcome.ok) {
    log(
      "\nSetup stopped. Fix the problem above, then run openclaw privacy setup again; finished steps are skipped or repeated safely.",
    );
    return false;
  }
  // The background service may not see a docker command that lives in your home folder.
  if (!lite) {
    const where = await runProcess("sh", ["-c", "command -v docker"], { env: { ...process.env } });
    const dockerPath = where.stdout.trim();
    if (dockerPath.startsWith(`${homedir()}/`)) {
      outcome.warnings.push(
        `the docker command is in ${dockerPath}, which background services may not see. If private agents later report that Docker is unavailable, make docker available in /usr/local/bin (OrbStack and Docker Desktop offer this in their settings).`,
      );
    }
  }
  if (lite) {
    log(
      "\nLite mode is on. For full mode later (shell and file tools in a container): install OrbStack (https://orbstack.dev), open it, then run: openclaw privacy setup --overwrite",
    );
  }
  if (outcome.warnings.length > 0) {
    log("\nFinished, with things to do:");
    for (const warning of outcome.warnings) {
      log(`  - ${warning}`);
    }
    return true;
  }
  log(
    '\nDone. Ask your assistant on Telegram: "Ask the inbox agent what it can do."\nCheck the private side any time with: openclaw --profile private privacy status',
  );
  return true;
}

export function registerPrivacySetupCli(privacy: PrivacyCommand, packVersion: string): void {
  privacy
    .command("setup")
    .description("Set up the private gateway and connect it to this one, in one guided step")
    .option("--provider <name>", "Private model service: tinfoil or privatemode")
    .option("--key-env <variable>", "Read the provider API key from this environment variable")
    .option("--port <port>", `Private gateway port (default ${DEFAULT_PRIVATE_PORT})`)
    .option("--overwrite", "Replace an existing private gateway config (a backup is kept)")
    .option(
      "--from <folder>",
      "Install the plugins from `npm pack` tarballs in this folder instead of npm (for testing)",
    )
    .option(
      "--lite",
      "No Docker: the private agent gets no shell, file or browser tools (offered when Docker is missing)",
    )
    .option("--dry-run", "Show what would happen and change nothing")
    .option("--yes", "Do not ask for confirmation")
    .action(async (opts: SetupOptions) => {
      const ok = await runPrivacySetup(opts, { packVersion }).catch((error: unknown) => {
        console.error(error instanceof Error ? error.message : String(error));
        return false;
      });
      if (!ok) {
        process.exitCode = 1;
      }
    });
}
