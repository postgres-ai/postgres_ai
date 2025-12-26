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

// Try to find the postgresai package
try {
  // First try to resolve from node_modules - look for the compiled dist version
  const postgresaiPkg = require.resolve("postgresai/package.json");
  target = resolve(dirname(postgresaiPkg), "dist", "bin", "postgres-ai.js");

  // Fallback to source TS if dist doesn't exist (development)
  if (!existsSync(target)) {
    target = resolve(dirname(postgresaiPkg), "bin", "postgres-ai.ts");
  }
} catch {
  // Dev-friendly fallback when running from the monorepo checkout (postgresai lives under ../cli).
  const fallbackJs = resolve(__dirname, "..", "..", "cli", "dist", "bin", "postgres-ai.js");
  const fallbackTs = resolve(__dirname, "..", "..", "cli", "bin", "postgres-ai.ts");

  if (existsSync(fallbackJs)) {
    target = fallbackJs;
  } else if (existsSync(fallbackTs)) {
    target = fallbackTs;
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
const isTsFile = target.endsWith(".ts");
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
