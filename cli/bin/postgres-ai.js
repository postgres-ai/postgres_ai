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

function resolvePaths() {
  const path = require("path");
  const fs = require("fs");
  const projectDir = process.cwd();
  const composeFile = path.resolve(projectDir, "docker-compose.yml");
  const instancesFile = path.resolve(projectDir, "instances.yml");
  return { fs, path, projectDir, composeFile, instancesFile };
}

function getComposeCmd() {
  const { spawnSync } = require("child_process");
  const tryCmd = (cmd, args) => spawnSync(cmd, args, { stdio: "ignore" }).status === 0;
  if (tryCmd("docker-compose", ["version"])) return ["docker-compose"];
  if (tryCmd("docker", ["compose", "version"])) return ["docker", "compose"];
  return null;
}

async function runCompose(args) {
  const { composeFile } = resolvePaths();
  const cmd = getComposeCmd();
  if (!cmd) {
    console.error("docker compose not found (need docker-compose or docker compose)");
    process.exitCode = 1;
    return 1;
  }
  const { spawn } = require("child_process");
  return new Promise((resolve) => {
    const child = spawn(cmd[0], [...cmd.slice(1), "-f", composeFile, ...args], { stdio: "inherit" });
    child.on("close", (code) => resolve(code));
  });
}

program.command("help", { isDefault: true }).description("show help").action(() => {
  program.outputHelp();
});

// Service lifecycle
program.command("quickstart").description("complete setup").action(stub("quickstart"));
program.command("install").description("install project").action(stub("install"));
program
  .command("start")
  .description("start services")
  .action(async () => {
    const code = await runCompose(["up", "-d"]);
    if (code !== 0) process.exitCode = code;
  });
program
  .command("stop")
  .description("stop services")
  .action(async () => {
    const code = await runCompose(["down"]);
    if (code !== 0) process.exitCode = code;
  });
program
  .command("restart")
  .description("restart services")
  .action(async () => {
    const code = await runCompose(["restart"]);
    if (code !== 0) process.exitCode = code;
  });
program
  .command("status")
  .description("show service status")
  .action(async () => {
    const code = await runCompose(["ps"]);
    if (code !== 0) process.exitCode = code;
  });
program
  .command("logs [service]")
  .option("-f, --follow", "follow logs", false)
  .description("show logs for all or specific service")
  .action(async (service, opts) => {
    const args = ["logs"]; if (opts.follow) args.push("-f"); if (service) args.push(service);
    const code = await runCompose(args);
    if (code !== 0) process.exitCode = code;
  });
program.command("health").description("health check").action(stub("health"));
program
  .command("config")
  .description("show configuration")
  .action(async () => {
    const { fs, projectDir, composeFile, instancesFile } = resolvePaths();
    console.log(`Project Directory: ${projectDir}`);
    console.log(`Docker Compose File: ${composeFile}`);
    console.log(`Instances File: ${instancesFile}`);
    if (fs.existsSync(instancesFile)) {
      console.log("\nInstances configuration:\n");
      const text = fs.readFileSync(instancesFile, "utf8");
      process.stdout.write(text);
      if (!/\n$/.test(text)) console.log();
    }
  });
program
  .command("update-config")
  .description("apply configuration (generate sources)")
  .action(async () => {
    const code = await runCompose(["run", "--rm", "sources-generator"]);
    if (code !== 0) process.exitCode = code;
  });
program.command("update").description("update project").action(stub("update"));
program
  .command("reset [service]")
  .description("reset all or specific service")
  .action(stub("reset"));
program.command("clean").description("cleanup artifacts").action(stub("clean"));
program
  .command("shell <service>")
  .description("open service shell")
  .action(async (service) => {
    const code = await runCompose(["exec", "-T", service, "/bin/sh"]);
    if (code !== 0) process.exitCode = code;
  });
program
  .command("check")
  .description("system readiness check")
  .action(async () => {
    const code = await runCompose(["ps"]);
    if (code !== 0) process.exitCode = code;
  });

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

 