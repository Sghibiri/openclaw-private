// Tinfoil plugin registration: provider on the loopback relay, relay as a service.
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { capturePlugin } from "../../test/fake-plugin-api.js";
import plugin from "./index.js";
import { TINFOIL_BASE_URL } from "./models.js";
import { loadOrCreateTinfoilUserCacheSecret } from "./src/user-cache-secret.js";

describe("tinfoil provider plugin", () => {
  let stateDir: string;
  let previousStateDir: string | undefined;

  beforeEach(() => {
    stateDir = mkdtempSync(path.join(os.tmpdir(), "openclaw-tinfoil-"));
    previousStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = stateDir;
  });

  afterEach(() => {
    if (previousStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = previousStateDir;
    }
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("serves the provider from the loopback relay, never straight from Tinfoil", () => {
    const captured = capturePlugin(plugin);
    const provider = captured.first<{
      id: string;
      catalog?: unknown;
      createModelFetch?: unknown;
    }>("registerProvider");
    expect(provider.id).toBe("tinfoil");
    expect(provider.catalog).toBeDefined();
    expect(provider.createModelFetch).toBeUndefined();
    expect(TINFOIL_BASE_URL).toBe("http://127.0.0.1:19931/v1");
    expect(captured.all<{ id: string }>("registerService").map((s) => s.id)).toEqual([
      "tinfoil-attested-relay",
    ]);
  });

  it("creates a private per-gateway cache-scoping secret with 0600 permissions", () => {
    loadOrCreateTinfoilUserCacheSecret();
    const file = path.join(stateDir, "tinfoil", "user-cache-secret");
    expect(readFileSync(file, "utf8").trim()).toMatch(/^[0-9a-f]{64}$/);
    if (process.platform !== "win32") {
      expect(statSync(file).mode & 0o777).toBe(0o600);
    }
  });
});
