#!/usr/bin/env bun

import { spawn } from "child_process";
import { resolve, dirname } from "path";
import { existsSync } from "fs";
import { createRequire } from "module";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const require = createRequire(import.meta.url);

function die(msg: string): never {
  process.stderr.write(`${msg}\n`);
  process.exit(1);
}

let target: string;
// isTsFile determines runtime: true = use bun (for .ts), false = use node (for .js)
let isTsFile = false;

// Try to find the postgresai package
try {
  // Resolve the exported "cli" entry point from the postgresai package.
  // This uses the exports field which is the proper way to resolve ESM packages.
  target = require.resolve("postgresai/cli");
  isTsFile = target.endsWith(".ts");
} catch {
  // Dev-friendly fallback when running from the monorepo checkout (postgresai lives under ../cli).
  const fallbackJs = resolve(__dirname, "..", "..", "cli", "dist", "bin", "postgres-ai.js");
  const fallbackTs = resolve(__dirname, "..", "..", "cli", "bin", "postgres-ai.ts");

  if (existsSync(fallbackJs)) {
    target = fallbackJs;
  } else if (existsSync(fallbackTs)) {
    target = fallbackTs;
    isTsFile = true;
  } else {
    die(
      [
        "pgai: failed to locate postgresai package.",
        "",
        "This wrapper expects postgresai to be installed as a dependency.",
      ].join("\n")
    );
  }
}

// Determine if we should use node or bun based on the file extension
const runtime = isTsFile ? "bun" : process.execPath;

const child = spawn(runtime, [target, ...process.argv.slice(2)], {
  stdio: "inherit",
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});

child.on("error", (err) => {
  die(`pgai: failed to run postgresai: ${err instanceof Error ? err.message : String(err)}`);
});
