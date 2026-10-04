// Per-gateway prompt-cache scoping secret for Tinfoil.
//
// Tinfoil scopes its prompt cache by `user_cache_secret`. The SDK default is a
// file under the user's home shared by every Tinfoil client on the machine; a
// private gateway keeps its own so no other process shares its cache namespace.
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";

const SECRET_FILE = path.join("tinfoil", "user-cache-secret");
const SECRET_BYTES = 32;

export function resolveTinfoilUserCacheSecretPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveStateDir(env), SECRET_FILE);
}

/** Read the gateway's cache-scoping secret, creating it (mode 0600) on first use. */
export function loadOrCreateTinfoilUserCacheSecret(env: NodeJS.ProcessEnv = process.env): string {
  const file = resolveTinfoilUserCacheSecretPath(env);
  try {
    const existing = readFileSync(file, "utf8").trim();
    if (existing.length >= SECRET_BYTES * 2) {
      return existing;
    }
  } catch {
    // Missing or unreadable: create below.
  }
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const secret = randomBytes(SECRET_BYTES).toString("hex");
  writeFileSync(file, `${secret}\n`, { mode: 0o600 });
  return secret;
}
