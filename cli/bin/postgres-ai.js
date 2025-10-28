#!/usr/bin/env node
"use strict";

const { Command } = require("commander");
const pkg = require("../package.json");

function getConfig(opts) {
  const apiKey = opts.apiKey || process.env.PGAIS_API_KEY || "";
  const baseUrl =
    opts.baseUrl || process.env.PGAIS_BASE_URL || "https://v2.postgres.ai/api/general/";
  return { apiKey, baseUrl };
}

const program = new Command();

program
  .name("postgres-ai")
  .description("PostgresAI CLI")
  .version(pkg.version)
  .option("--api-key <key>", "API key (overrides PGAIS_API_KEY)")
  .option(
    "--base-url <url>",
    "API base URL (overrides PGAIS_BASE_URL)",
    "https://v2.postgres.ai/api/general/"
  );

const stub = (name) => async () => {
  // Temporary stubs until Node parity is implemented
  console.error(`${name}: not implemented in Node CLI yet; use bash CLI for now`);
  process.exitCode = 2;
};

program.command("help", { isDefault: true }).description("show help").action(() => {
  program.outputHelp();
});

// Service lifecycle
program.command("quickstart").description("complete setup").action(stub("quickstart"));
program.command("install").description("install project").action(stub("install"));
program.command("start").description("start services").action(stub("start"));
program.command("stop").description("stop services").action(stub("stop"));
program.command("restart").description("restart services").action(stub("restart"));
program.command("status").description("show service status").action(stub("status"));
program
  .command("logs [service]")
  .description("show logs for all or specific service")
  .action(stub("logs"));
program.command("health").description("health check").action(stub("health"));
program.command("config").description("show configuration").action(stub("config"));
program.command("update-config").description("apply configuration").action(stub("update-config"));
program.command("update").description("update project").action(stub("update"));
program
  .command("reset [service]")
  .description("reset all or specific service")
  .action(stub("reset"));
program.command("clean").description("cleanup artifacts").action(stub("clean"));
program.command("shell <service>").description("open service shell").action(stub("shell"));
program.command("check").description("system readiness check").action(stub("check"));

// Instance management
program.command("list-instances").description("list instances").action(stub("list-instances"));
program
  .command("add-instance [connStr] [name]")
  .description("add instance")
  .action(stub("add-instance"));
program
  .command("remove-instance <name>")
  .description("remove instance")
  .action(stub("remove-instance"));
program
  .command("test-instance <name>")
  .description("test instance connectivity")
  .action(stub("test-instance"));

// API key and grafana
program.command("add-key <apiKey>").description("store API key").action(stub("add-key"));
program.command("show-key").description("show API key (masked)").action(stub("show-key"));
program.command("remove-key").description("remove API key").action(stub("remove-key"));
program
  .command("generate-grafana-password")
  .description("generate Grafana password")
  .action(stub("generate-grafana-password"));
program
  .command("show-grafana-credentials")
  .description("show Grafana credentials")
  .action(stub("show-grafana-credentials"));

program.parseAsync(process.argv);

 