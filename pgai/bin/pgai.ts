#!/usr/bin/env bun

import { resolve, dirname } from "path";
import { existsSync } from "fs";

function die(msg: string): never {
  process.stderr.write(`${msg}\n`);
  process.exit(1);
}

let target: string;

// Try to find the postgresai package
try {
  // First try to resolve from node_modules
  const postgreaiIndex = require.resolve("postgresai");
  target = resolve(dirname(postgreaiIndex), "..", "bin", "postgres-ai.ts");
} catch {
  // Dev-friendly fallback when running from the monorepo checkout (postgresai lives under ../cli).
  const fallback = resolve(import.meta.dir, "..", "..", "cli", "bin", "postgres-ai.ts");
  if (existsSync(fallback)) {
    target = fallback;
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

// Import and run the main CLI
const mainModule = await import(target);

// The CLI parses process.argv and runs automatically, so we don't need to do anything else
