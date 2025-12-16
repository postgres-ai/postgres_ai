#!/usr/bin/env node
"use strict";

const { spawn } = require("node:child_process");

function die(msg) {
  process.stderr.write(`${msg}\n`);
  process.exitCode = 1;
}

let target;
try {
  target = require.resolve("postgresai/dist/bin/postgres-ai.js");
} catch (e) {
  die(
    [
      "pgai: failed to locate postgresai package.",
      "",
      "This wrapper expects postgresai to be installed as a dependency.",
    ].join("\n")
  );
  process.exit(1);
}

const child = spawn(process.execPath, [target, ...process.argv.slice(2)], {
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


