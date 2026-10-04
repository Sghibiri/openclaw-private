// Carries out the setup plan step by step. Every step reports what it did in
// plain words, can run again safely, and on failure says what to do next.
//
// Re-runs keep the two gateways in step: door tokens already in the `.env`
// files are reused, and the private service is reinstalled so it loads the
// current config and environment.
import path from "node:path";
import {
  applyMainConfig,
  buildPrivateConfig,
  DOOR_TOKENS,
  PRIVATE_GATEWAY_TOKEN,
  PRIVATE_PROFILE,
  SANDBOX_DOCKERFILE,
  SANDBOX_IMAGE,
  type SetupAnswers,
  type SetupStep,
} from "./plan.js";

export type RunResult = { code: number; stdout: string; stderr: string };
type Env = Record<string, string | undefined>;

export type SetupDeps = {
  run: (
    command: string,
    args: string[],
    options: { input?: string; env: Env },
  ) => Promise<RunResult>;
  /** How to start this same OpenClaw CLI (node plus its entry script). */
  openclaw: { command: string; args: string[] };
  /** The environment children start from. */
  env: Env;
  /** The private profile's state folder (`<OpenClaw home>/.openclaw-private`). */
  privateStateDir: string;
  /** The main gateway's `.env` file. */
  mainEnvFile: string;
  readFile: (file: string) => Promise<string | undefined>;
  fileExists: (file: string) => Promise<boolean>;
  /** Writes owner-only through a temporary file and a rename, so a crash never truncates. */
  writeFileAtomic: (file: string, content: string) => Promise<void>;
  rename: (from: string, to: string) => Promise<void>;
  mutateMainConfig: (mutate: (draft: Record<string, unknown>) => string[]) => Promise<string[]>;
  /** POSTs a harmless request through the door; returns the HTTP status (0 when unreachable). */
  probeDoor: (url: string, token: string) => Promise<number>;
  sleep: (ms: number) => Promise<void>;
  randomToken: () => string;
  log: (line: string) => void;
};

export type SetupOutcome =
  | { ok: true; warnings: string[] }
  | { ok: false; step: SetupStep["kind"]; message: string };

class StepFailed extends Error {}

const TOKEN_NAMES = [DOOR_TOKENS.inbound, DOOR_TOKENS.outbound, PRIVATE_GATEWAY_TOKEN];

function lastLines(text: string, count = 3): string {
  return text.trim().split("\n").slice(-count).join(" / ");
}

const envLine = (name: string) => new RegExp(`^\\s*(?:export\\s+)?${name}=`, "u");

/** Values of the given names in a `.env` file (unquoted, last one wins). */
export function readEnvValues(content: string | undefined, names: string[]): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of (content ?? "").split("\n")) {
    for (const name of names) {
      if (envLine(name).test(line)) {
        const value = line
          .slice(line.indexOf("=") + 1)
          .trim()
          .replace(/^(["'])(.*)\1$/u, "$2");
        if (value) {
          values.set(name, value);
        }
      }
    }
  }
  return values;
}

/** The file with the given names set; every other line is kept exactly as it was. */
export function mergeEnv(content: string | undefined, values: Map<string, string>): string {
  const lines =
    content === undefined || content === "" ? [] : content.replace(/\n$/u, "").split("\n");
  const pending = new Map(values);
  const merged = lines.map((line) => {
    for (const [name, value] of pending) {
      if (envLine(name).test(line)) {
        pending.delete(name);
        return `${name}=${value}`;
      }
    }
    return line;
  });
  for (const [name, value] of pending) {
    merged.push(`${name}=${value}`);
  }
  return `${merged.join("\n")}\n`;
}

/** The last JSON object in a command's output that has the given key. */
function parseJsonWith<T>(stdout: string, key: string): T | undefined {
  const starts = [...stdout.matchAll(/(?:^|\n)\{/gu)].map(
    (match) => match.index + (match[0].startsWith("\n") ? 1 : 0),
  );
  for (const start of starts.toReversed()) {
    try {
      const value = JSON.parse(stdout.slice(start)) as Record<string, unknown>;
      if (key in value) {
        return value as T;
      }
    } catch {
      // Not the JSON document; try an earlier start.
    }
  }
  return undefined;
}

export async function runSetup(params: {
  steps: SetupStep[];
  answers: SetupAnswers;
  providerKey: string;
  overwrite?: boolean;
  /** Environment variables holding secrets; never passed to children. */
  secretEnvNames?: string[];
  deps: SetupDeps;
}): Promise<SetupOutcome> {
  const { deps, answers } = params;
  const privateConfigPath = path.join(deps.privateStateDir, "openclaw.json");
  const privateEnvFile = path.join(deps.privateStateDir, ".env");
  const warnings: string[] = [];

  // Reuse tokens already written, so a re-run keeps both gateways in step.
  const mainEnv = readEnvValues(await deps.readFile(deps.mainEnvFile), TOKEN_NAMES);
  const privateEnv = readEnvValues(await deps.readFile(privateEnvFile), TOKEN_NAMES);
  const tokens = new Map<string, string>();
  for (const name of TOKEN_NAMES) {
    tokens.set(name, mainEnv.get(name) ?? privateEnv.get(name) ?? deps.randomToken());
  }

  // Children get an explicit environment: no secrets and no inherited door
  // tokens. Private steps also drop the parent's folder and gateway settings,
  // so `--profile private` resolves its own default folder; OpenClaw only
  // installs a service for a profile's default paths.
  const scrubbed: Env = { ...deps.env };
  for (const name of [...TOKEN_NAMES, ...(params.secretEnvNames ?? [])]) {
    delete scrubbed[name];
  }
  const privateEnvVars: Env = { ...scrubbed };
  for (const name of Object.keys(privateEnvVars)) {
    if (
      name === "OPENCLAW_PROFILE" ||
      name === "OPENCLAW_STATE_DIR" ||
      name === "OPENCLAW_CONFIG_PATH" ||
      name.startsWith("OPENCLAW_GATEWAY_")
    ) {
      delete privateEnvVars[name];
    }
  }

  const openclaw = (profile: "main" | "private", args: string[], input?: string) =>
    deps.run(
      deps.openclaw.command,
      [
        ...deps.openclaw.args,
        ...(profile === "private" ? ["--profile", PRIVATE_PROFILE] : []),
        ...args,
      ],
      {
        ...(input !== undefined ? { input } : {}),
        env: profile === "private" ? privateEnvVars : scrubbed,
      },
    );
  const docker = (args: string[], input?: string) =>
    deps.run("docker", args, { ...(input !== undefined ? { input } : {}), env: scrubbed });
  const ok = (line: string) => deps.log(`  ok  ${line}`);
  const warn = (line: string) => {
    warnings.push(line);
    deps.log(`  !!  ${line}`);
  };

  const steps: Record<SetupStep["kind"], (step: never) => Promise<void>> = {
    "check-docker": async () => {
      const result = await docker(["info", "--format", "{{.ServerVersion}}"]);
      if (result.code !== 0) {
        const detail = lastLines(result.stderr || result.stdout, 1);
        throw new StepFailed(
          `Docker is not running${detail ? ` (${detail})` : ""}. Private agents run their tools inside a container. Install OrbStack (https://orbstack.dev) or Docker Desktop, open it once, then run: openclaw privacy setup. Or set up without Docker: openclaw privacy setup --lite`,
        );
      }
      ok(`Docker ${result.stdout.trim()} is running`);
    },
    "build-sandbox-image": async () => {
      if ((await docker(["image", "inspect", SANDBOX_IMAGE])).code === 0) {
        ok(`sandbox image ${SANDBOX_IMAGE} is already built`);
        return;
      }
      deps.log(`  ..  building the sandbox image (a few minutes the first time)`);
      const result = await docker(["build", "-t", SANDBOX_IMAGE, "-"], SANDBOX_DOCKERFILE);
      if (result.code !== 0) {
        throw new StepFailed(`Building the sandbox image failed: ${lastLines(result.stderr)}`);
      }
      ok(`built the sandbox image ${SANDBOX_IMAGE}`);
    },
    "store-secret": async (step: Extract<SetupStep, { kind: "store-secret" }>) => {
      const result = await openclaw(
        step.profile,
        ["secrets", "store", "set", step.name, "--kind", "secret"],
        params.providerKey,
      );
      if (result.code !== 0) {
        throw new StepFailed(`Storing ${step.name} failed: ${lastLines(result.stderr)}`);
      }
      ok(`stored ${step.name} in the ${step.profile} gateway's secret store`);
    },
    "write-env": async (step: Extract<SetupStep, { kind: "write-env" }>) => {
      const file = step.profile === "main" ? deps.mainEnvFile : privateEnvFile;
      const values = new Map(step.names.map((name) => [name, tokens.get(name) as string]));
      await deps.writeFileAtomic(file, mergeEnv(await deps.readFile(file), values));
      ok(`set ${step.names.join(", ")} in ${file} (readable only by you)`);
    },
    "write-private-config": async () => {
      if (await deps.fileExists(privateConfigPath)) {
        if (!params.overwrite) {
          let existing: {
            gateway?: { port?: unknown };
            models?: { providers?: Record<string, unknown> };
            plugins?: { entries?: { "privacy-core"?: { config?: { sandbox?: unknown } } } };
          };
          try {
            existing = JSON.parse(
              (await deps.readFile(privateConfigPath)) ?? "",
            ) as typeof existing;
          } catch {
            throw new StepFailed(
              `${privateConfigPath} exists but is not plain JSON. Run again with --overwrite to replace it (a backup is kept).`,
            );
          }
          const sameProvider = Boolean(existing.models?.providers?.[answers.provider]);
          const samePort = existing.gateway?.port === answers.privatePort;
          const existingLite =
            existing.plugins?.entries?.["privacy-core"]?.config?.sandbox === "off";
          const sameMode = existingLite === Boolean(answers.lite);
          if (!sameProvider || !samePort || !sameMode) {
            const differences = [
              ...(sameProvider ? [] : [`a provider other than ${answers.provider}`]),
              ...(samePort ? [] : [`port ${String(existing.gateway?.port)}`]),
              ...(sameMode ? [] : [existingLite ? "lite mode (no Docker)" : "full mode (Docker)"]),
            ];
            throw new StepFailed(
              `${privateConfigPath} is set up for ${differences.join(" and ")}. Run again with --overwrite to replace it (a backup is kept).`,
            );
          }
          ok(`kept the existing private config ${privateConfigPath}`);
          return;
        }
        const backup = `${privateConfigPath}.before-setup-${Date.now()}`;
        await deps.rename(privateConfigPath, backup);
        deps.log(`  ..  saved the old private config as ${backup}`);
      }
      await deps.writeFileAtomic(
        privateConfigPath,
        `${JSON.stringify(buildPrivateConfig(answers), null, 2)}\n`,
      );
      ok(`wrote the private gateway config ${privateConfigPath}`);
    },
    "install-plugin": async (step: Extract<SetupStep, { kind: "install-plugin" }>) => {
      const result = await openclaw("private", [
        "plugins",
        "install",
        step.spec,
        "--force",
        "--accept-capabilities",
      ]);
      if (result.code !== 0) {
        throw new StepFailed(
          `Installing ${step.spec} on the private gateway failed: ${lastLines(result.stderr || result.stdout)}`,
        );
      }
      ok(`installed ${step.spec} on the private gateway`);
    },
    "update-main-config": async () => {
      const changes = await deps.mutateMainConfig((draft) => applyMainConfig(draft, answers));
      ok(
        changes.length > 0
          ? `main gateway config: ${changes.join("; ")}`
          : "main gateway config already has the door",
      );
    },
    "install-private-service": async () => {
      // --force reinstalls, so the service picks up the current config and .env.
      const result = await openclaw("private", [
        "gateway",
        "install",
        "--force",
        "--port",
        String(answers.privatePort),
      ]);
      if (result.code !== 0) {
        throw new StepFailed(
          `Starting the private gateway as a service failed: ${lastLines(result.stderr || result.stdout)}`,
        );
      }
      ok(`installed and started the private gateway on port ${answers.privatePort}`);
    },
    "restart-main-gateway": async () => {
      const result = await openclaw("main", ["gateway", "restart"]);
      if (result.code === 0) {
        ok("restarted the main gateway");
      } else {
        warn(
          "could not restart the main gateway, so it does not know the door yet; run: openclaw gateway restart",
        );
      }
    },
    verify: async () => {
      const result = await openclaw("private", ["privacy", "status", "--json"]);
      const report = parseJsonWith<{
        mode?: string;
        issues?: Array<{ path: string; message: string }>;
      }>(result.stdout, "issues");
      if (result.code !== 0 || !report?.issues) {
        throw new StepFailed(
          `Could not read the private gateway's status: ${lastLines(result.stderr || result.stdout)}`,
        );
      }
      if (report.mode !== "private") {
        throw new StepFailed(
          `The private profile is not in private mode (found "${String(report.mode)}"). Check ${privateConfigPath}, or run again with --overwrite.`,
        );
      }
      if (report.issues.length > 0) {
        throw new StepFailed(
          `The private config has ${report.issues.length} problem(s):\n${report.issues.map((issue) => `      - ${issue.path}: ${issue.message}`).join("\n")}`,
        );
      }
      ok(
        answers.lite
          ? "private gateway: privacy config ok (lite mode: no shell, file or browser tools)"
          : "private gateway: privacy config ok, agent runs allowed",
      );
    },
    "check-door": async () => {
      const url = `http://127.0.0.1:${answers.privatePort}/a2a/v1`;
      const token = tokens.get(DOOR_TOKENS.outbound) as string;
      let status = 0;
      // A freshly started gateway takes a little while to open the door.
      for (let attempt = 0; attempt < 30; attempt += 1) {
        status = await deps.probeDoor(url, token);
        if (status !== 0 && status !== 502 && status !== 503) {
          break;
        }
        await deps.sleep(2000);
      }
      if (status === 401 || status === 403) {
        throw new StepFailed(
          "The private gateway refused the door token. Run openclaw privacy setup again; it keeps both gateways' tokens in step.",
        );
      }
      if (status < 200 || status >= 500) {
        throw new StepFailed(
          `The private gateway did not answer at ${url} (status ${status}). Check it with: openclaw --profile private gateway status`,
        );
      }
      ok("the door to the private gateway answers and accepts its token");
    },
  };

  for (const step of params.steps) {
    try {
      await steps[step.kind](step as never);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      deps.log(`  xx  ${message}`);
      return { ok: false, step: step.kind, message };
    }
  }
  return { ok: true, warnings };
}
