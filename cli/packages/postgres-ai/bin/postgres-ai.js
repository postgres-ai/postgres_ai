#!/usr/bin/env node
/**
 * postgres-ai wrapper - forwards all commands to postgresai CLI
 * 
 * This package exists for discoverability. For direct installation,
 * prefer: npm install -g postgresai
 */
const { spawn } = require('child_process');

// Find postgresai binary from the dependency
// Uses the "cli" export defined in postgresai's package.json
const postgresaiBin = require.resolve('postgresai/cli');

// Forward all arguments to postgresai
const child = spawn(process.execPath, [postgresaiBin, ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: process.env,
});

child.on('close', (code) => {
  process.exit(code ?? 0);
});

child.on('error', (err) => {
  console.error(`Failed to start postgresai: ${err.message}`);
  process.exit(1);
});
