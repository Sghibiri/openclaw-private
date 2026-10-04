// Guard: production code must never import the unverified Tinfoil client.
// The `tinfoil/unsafe` subpath skips attestation; it exists for SDK development only.
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOTS = ["plugins", "shared"];
const FORBIDDEN = [
  /from\s+["']tinfoil\/unsafe["']/u,
  /\bUnverifiedClient\b/u,
  /createUnverifiedEncryptedBodyFetch/u,
];
const SOURCE_RE = /\.(?:ts|mts|cts|js|mjs|cjs)$/u;

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry.startsWith(".")) {
      continue;
    }
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      yield* walk(full);
    } else if (SOURCE_RE.test(entry) && !/\.test\.[cm]?[jt]s$/u.test(entry)) {
      yield full;
    }
  }
}

describe("attestation cannot be skipped in production code", () => {
  it("has no import of the unverified Tinfoil client", () => {
    const offenders: string[] = [];
    for (const root of ROOTS) {
      for (const file of walk(root)) {
        const text = readFileSync(file, "utf8");
        if (FORBIDDEN.some((pattern) => pattern.test(text))) {
          offenders.push(file);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
