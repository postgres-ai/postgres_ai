#!/usr/bin/env node
"use strict";

const { Command } = require("commander");
const pkg = require("../package.json");

function getConfig(opts) {
  const apiKey = opts.apiKey || process.env.PGAI_API_KEY || "";
  const baseUrl =
    opts.baseUrl || process.env.PGAI_BASE_URL || "https://v2.postgres.ai/api/general/";
  return { apiKey, baseUrl };
}

const program = new Command();

program
  .name("postgres-ai")
  .description("PostgresAI CLI")
  .version(pkg.version)
  .option("--api-key <key>", "API key (overrides PGAI_API_KEY)")
  .option(
    "--base-url <url>",
    "API base URL (overrides PGAI_BASE_URL)",
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
program
  .command("list-instances")
  .description("list instances")
  .action(async () => {
    const fs = require("fs");
    const path = require("path");
    const instancesPath = path.resolve(process.cwd(), "instances.yml");
    if (!fs.existsSync(instancesPath)) {
      console.error(`instances.yml not found in ${process.cwd()}`);
      process.exitCode = 1;
      return;
    }
    const content = fs.readFileSync(instancesPath, "utf8");
    const lines = content.split(/\r?\n/);
    let currentName = "";
    let printed = false;
    for (const line of lines) {
      const m = line.match(/^-[\t ]*name:[\t ]*(.+)$/);
      if (m) {
        currentName = m[1].trim();
        console.log(`Instance: ${currentName}`);
        printed = true;
      }
    }
    if (!printed) {
      console.log("No instances found");
    }
  });
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
program
  .command("add-key <apiKey>")
  .description("store API key")
  .action(async (apiKey) => {
    const fs = require("fs");
    const path = require("path");
    const cfgPath = path.resolve(process.cwd(), ".pgwatch-config");
    const existing = fs.existsSync(cfgPath) ? fs.readFileSync(cfgPath, "utf8") : "";
    const filtered = existing
      .split(/\r?\n/)
      .filter((l) => !/^api_key=/.test(l))
      .join("\n")
      .replace(/\n+$/g, "");
    const next = filtered.length ? `${filtered}\napi_key=${apiKey}\n` : `api_key=${apiKey}\n`;
    fs.writeFileSync(cfgPath, next, "utf8");
    console.log("API key saved to .pgwatch-config");
  });

program
  .command("show-key")
  .description("show API key (masked)")
  .action(async () => {
    const fs = require("fs");
    const path = require("path");
    const cfgPath = path.resolve(process.cwd(), ".pgwatch-config");
    if (!fs.existsSync(cfgPath)) {
      console.log("No API key configured");
      return;
    }
    const content = fs.readFileSync(cfgPath, "utf8");
    const m = content.match(/^api_key=(.+)$/m);
    if (!m) {
      console.log("No API key configured");
      return;
    }
    const key = m[1].trim();
    if (!key) {
      console.log("No API key configured");
      return;
    }
    const mask = (k) => (k.length <= 8 ? "****" : `${k.slice(0, 4)}${"*".repeat(k.length - 8)}${k.slice(-4)}`);
    console.log(`Current API key: ${mask(key)}`);
  });

program
  .command("remove-key")
  .description("remove API key")
  .action(async () => {
    const fs = require("fs");
    const path = require("path");
    const cfgPath = path.resolve(process.cwd(), ".pgwatch-config");
    if (!fs.existsSync(cfgPath)) {
      console.log("No API key configured");
      return;
    }
    const content = fs.readFileSync(cfgPath, "utf8");
    const filtered = content
      .split(/\r?\n/)
      .filter((l) => !/^api_key=/.test(l))
      .join("\n")
      .replace(/\n+$/g, "\n");
    fs.writeFileSync(cfgPath, filtered, "utf8");
    console.log("API key removed");
  });
program
  .command("generate-grafana-password")
  .description("generate Grafana password")
  .action(stub("generate-grafana-password"));
program
  .command("show-grafana-credentials")
  .description("show Grafana credentials")
  .action(stub("show-grafana-credentials"));

program.parseAsync(process.argv);

 