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

function runProcess(
  command: string,
  args: string[],
  options: { input?: string; env: Record<string, string | undefined> },
): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: options.env as NodeJS.ProcessEnv,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    child.on("error", (error) => resolve({ code: 127, stdout, stderr: error.message }));
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    child.stdin.end(options.input ?? "");
  });
}

async function ask(question: string, hidden = false): Promise<string> {
  const { createInterface } = await import("node:readline/promises");
  const { Writable } = await import("node:stream");
  let muted = false;
  const output = new Writable({
    write(chunk, _encoding, done) {
      if (!muted) {
        process.stdout.write(chunk);
      }
      done();
    },
  });
  const rl = createInterface({ input: process.stdin, output, terminal: true });
  try {
    const pending = rl.question(question);
    muted = hidden;
    const answer = await pending;
    if (hidden) {
      process.stdout.write("\n");
    }
    return answer.trim();
  } finally {
    rl.close();
  }
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
    case "install-plugin":
      return `install ${step.spec} on the private gateway`;
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
    providerKey = await ask(`Paste your ${template.keyName} (hidden): `, true);
    if (!providerKey) {
      log("No key given; nothing was changed.");
      return false;
    }
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
  const deps: SetupDeps = {
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
    log,
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
