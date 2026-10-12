// Where the Privacy page's facts live, and reading them. Metadata only: the
// two configs, the private gateway's audit log, and its /readyz answer.
//
// On the main gateway the private gateway's files are read from its profile
// folder, the same place `openclaw privacy mail` uses; on the private gateway
// they are its own. Anything unreadable counts as missing, never as an error.
import { open, readFile } from "node:fs/promises";
import path from "node:path";
import { resolveRequiredHomeDir } from "openclaw/plugin-sdk/state-paths";
import { resolvePrivacyAuditLogPath } from "../../../../shared/audit.js";
import { parsePrivacyAuditRows } from "../audit-summary.js";
import { DEFAULT_PRIVATE_PORT, PRIVATE_PROFILE } from "../setup/plan.js";
import { buildPrivacyOverview, type PrivacyOverview } from "./overview.js";

const MAX_CONFIG_BYTES = 2 * 1024 * 1024;
const MAX_AUDIT_TAIL_BYTES = 4 * 1024 * 1024;
const READY_TIMEOUT_MS = 2_000;

async function readJsonConfig(file: string): Promise<unknown> {
  try {
    const text = await readFile(file, "utf8");
    return text.length > MAX_CONFIG_BYTES ? undefined : (JSON.parse(text) as unknown);
  } catch {
    return undefined;
  }
}

/** The newest rows of the audit log; a partial first line of the tail is dropped. */
async function readAuditTail(file: string) {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(file, "r");
    const { size } = await handle.stat();
    const start = Math.max(0, size - MAX_AUDIT_TAIL_BYTES);
    const buffer = Buffer.alloc(size - start);
    await handle.read(buffer, 0, buffer.length, start);
    const text = buffer.toString("utf8");
    return parsePrivacyAuditRows(start > 0 ? text.slice(text.indexOf("\n") + 1) : text).rows;
  } catch {
    return [];
  } finally {
    await handle?.close();
  }
}

function privateGatewayPort(privateConfig: unknown): number {
  const port = (privateConfig as { gateway?: { port?: unknown } } | undefined)?.gateway?.port;
  return typeof port === "number" && Number.isInteger(port) && port > 0 && port < 65_536
    ? port
    : DEFAULT_PRIVATE_PORT;
}

async function isReady(port: number, signal: AbortSignal): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/readyz`, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(READY_TIMEOUT_MS)]),
    });
    const body = (await response.json()) as { ready?: unknown };
    return response.ok && body.ready === true;
  } catch {
    return false;
  }
}

export async function loadPrivacyOverview(params: {
  mode: "standard" | "private";
  /** This gateway's own authored config. */
  ownConfig: unknown;
  env?: NodeJS.ProcessEnv;
  now: Date;
  signal: AbortSignal;
}): Promise<PrivacyOverview> {
  const env = params.env ?? process.env;
  const home = resolveRequiredHomeDir(env);
  if (params.mode === "private") {
    const [mainConfig, auditRows] = await Promise.all([
      readJsonConfig(path.join(home, ".openclaw", "openclaw.json")),
      readAuditTail(resolvePrivacyAuditLogPath(env)),
    ]);
    return buildPrivacyOverview({
      mainConfig,
      privateConfig: params.ownConfig,
      auditRows,
      privateReachable: true,
      now: params.now,
    });
  }
  const privateDir = path.join(home, `.openclaw-${PRIVATE_PROFILE}`);
  const privateConfig = await readJsonConfig(path.join(privateDir, "openclaw.json"));
  const [auditRows, privateReachable] = await Promise.all([
    readAuditTail(path.join(privateDir, "logs", "privacy-audit.jsonl")),
    privateConfig === undefined
      ? Promise.resolve(false)
      : isReady(privateGatewayPort(privateConfig), params.signal),
  ]);
  return buildPrivacyOverview({
    mainConfig: params.ownConfig,
    privateConfig,
    auditRows,
    privateReachable,
    now: params.now,
  });
}
