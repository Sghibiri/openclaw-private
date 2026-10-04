// Builds each plugin into plain JavaScript under plugins/<id>/dist, with the
// shared code it imports, so every plugin is a self-contained npm package.
// OpenClaw loads TypeScript only from source checkouts; npm installs need JS.
import { spawnSync } from "node:child_process";
import { copyFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tsc = createRequire(import.meta.url).resolve("typescript/bin/tsc");
const plugins = ["privacy-core", "tinfoil", "privatemode"];

for (const id of plugins) {
  const dir = path.join(root, "plugins", id);
  const outDir = path.join(dir, "dist");
  rmSync(outDir, { recursive: true, force: true });
  const config = path.join(dir, "tsconfig.build.json");
  writeFileSync(
    config,
    JSON.stringify(
      {
        extends: "../../tsconfig.json",
        compilerOptions: { noEmit: false, outDir: "dist", rootDir: "../..", sourceMap: false },
        files: ["index.ts", "../../types/openclaw-sdk-untyped.d.ts"],
        include: [],
      },
      null,
      2,
    ),
  );
  const result = spawnSync(process.execPath, [tsc, "-p", config], { stdio: "inherit" });
  rmSync(config, { force: true });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
  // Each package carries the licence texts it is published under.
  for (const file of ["LICENSE", "NOTICE"]) {
    copyFileSync(path.join(root, file), path.join(dir, file));
  }
  console.log(`built plugins/${id}/dist`);
}
