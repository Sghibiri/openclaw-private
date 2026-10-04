// Pinned Privatemode manifest under the gateway state dir.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";

const MANIFEST_FILE = path.join("privatemode", "manifest.json");

export function resolvePrivatemodeManifestPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveStateDir(env), MANIFEST_FILE);
}

export function readPinnedPrivatemodeManifest(
  env: NodeJS.ProcessEnv = process.env,
): Uint8Array | undefined {
  try {
    return new Uint8Array(readFileSync(resolvePrivatemodeManifestPath(env)));
  } catch {
    return undefined;
  }
}

export function writePinnedPrivatemodeManifest(
  bytes: Uint8Array,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const file = resolvePrivatemodeManifestPath(env);
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, bytes, { mode: 0o600 });
}
