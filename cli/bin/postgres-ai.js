#!/usr/bin/env node
"use strict";

const { Command } = require("commander");
const pkg = require("../package.json");

function getConfig(opts) {
  const apiKey = opts.apiKey || process.env.PGAI_API_KEY || "";
  const baseUrl =
    opts.baseUrl || process.env.PGAI_BASE_URL || "https://postgres.ai/api/general/";
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
    "https://postgres.ai/api/general/"
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
program
  .command("quickstart")
  .description("complete setup (generate config, start services)")
  .option("--demo", "demo mode", false)
  .action(async () => {
    const code1 = await runCompose(["run", "--rm", "sources-generator"]);
    if (code1 !== 0) {
      process.exitCode = code1;
      return;
    }
    const code2 = await runCompose(["up", "-d"]);
    if (code2 !== 0) process.exitCode = code2;
  });
program
  .command("install")
  .description("prepare project (no-op in repo checkout)")
  .action(async () => {
    console.log("Project files present; nothing to install.");
  });
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
program
  .command("health")
  .description("health check")
  .action(async () => {
    const { exec } = require("child_process");
    const util = require("util");
    const execPromise = util.promisify(exec);
    
    console.log("Checking service health...\n");
    
    const services = [
      { name: "Grafana", url: "http://localhost:3000/api/health" },
      { name: "Prometheus", url: "http://localhost:59090/-/healthy" },
      { name: "PGWatch (Postgres)", url: "http://localhost:58080/health" },
      { name: "PGWatch (Prometheus)", url: "http://localhost:58089/health" },
    ];
    
    let allHealthy = true;
    
    for (const service of services) {
      try {
        const { stdout, stderr } = await execPromise(
          `curl -sf -o /dev/null -w "%{http_code}" ${service.url}`,
          { timeout: 5000 }
        );
        const code = stdout.trim();
        if (code === "200") {
          console.log(`✓ ${service.name}: healthy`);
        } else {
          console.log(`✗ ${service.name}: unhealthy (HTTP ${code})`);
          allHealthy = false;
        }
      } catch (error) {
        console.log(`✗ ${service.name}: unreachable`);
        allHealthy = false;
      }
    }
    
    console.log("");
    if (allHealthy) {
      console.log("All services are healthy");
    } else {
      console.log("Some services are unhealthy");
      process.exitCode = 1;
    }
  });
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
    const collected = [];
    for (const line of lines) {
      const m = line.match(/^-[\t ]*name:[\t ]*(.+)$/);
      if (m) {
        currentName = m[1].trim();
        collected.push(currentName);
        printed = true;
      }
    }
    // Hide demo placeholder if that's the only entry
    if (printed) {
      const filtered = collected.filter((n) => n !== "target-database");
      const list = filtered.length > 0 ? filtered : [];
      if (list.length === 0) {
        console.log("No instances configured");
        console.log("");
        console.log("To add an instance:");
        console.log("  postgres-ai add-instance <connection-string> <name>");
        console.log("");
        console.log("Example:");
        console.log("  postgres-ai add-instance 'postgresql://user:pass@host:5432/db' my-db");
        return;
      }
      for (const n of list) console.log(`Instance: ${n}`);
    } else {
      console.log("No instances found");
    }
  });
program
  .command("add-instance [connStr] [name]")
  .description("add instance")
  .action(async (connStr, name) => {
    const fs = require("fs");
    const path = require("path");
    const file = path.resolve(process.cwd(), "instances.yml");
    if (!connStr) {
      console.error("Connection string required: postgresql://user:pass@host:port/db");
      process.exitCode = 1;
      return;
    }
    const m = connStr.match(/^postgresql:\/\/([^:]+):([^@]+)@([^:\/]+)(?::(\d+))?\/(.+)$/);
    if (!m) {
      console.error("Invalid connection string format");
      process.exitCode = 1;
      return;
    }
    const host = m[3];
    const db = m[5];
    const instanceName = name && name.trim() ? name.trim() : `${host}-${db}`.replace(/[^a-zA-Z0-9-]/g, "-");
    const lineStart = `- name: ${instanceName}`;
    const body = `- name: ${instanceName}\n  conn_str: ${connStr}\n  preset_metrics: full\n  custom_metrics:\n  is_enabled: true\n  group: default\n  custom_tags:\n    env: production\n    cluster: default\n    node_name: ${instanceName}\n    sink_type: ~sink_type~\n`;
    const content = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
    if (new RegExp(`^${lineStart}$`, "m").test(content)) {
      console.error(`Instance '${instanceName}' already exists`);
      process.exitCode = 1;
      return;
    }
    fs.appendFileSync(file, (content && !/\n$/.test(content) ? "\n" : "") + body, "utf8");
    console.log(`Instance '${instanceName}' added`);
  });
program
  .command("remove-instance <name>")
  .description("remove instance")
  .action(async (name) => {
    const fs = require("fs");
    const path = require("path");
    const file = path.resolve(process.cwd(), "instances.yml");
    if (!fs.existsSync(file)) {
      console.error("instances.yml not found");
      process.exitCode = 1;
      return;
    }
    const text = fs.readFileSync(file, "utf8");
    const lines = text.split(/\r?\n/);
    const out = [];
    let skip = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const isStart = /^-[\t ]*name:[\t ]*(.+)$/.test(line);
      if (isStart) {
        const n = line.replace(/^-[\t ]*name:[\t ]*/, "").trim();
        if (n === name) {
          skip = true;
          continue;
        } else if (skip) {
          skip = false;
        }
      }
      if (!skip) out.push(line);
    }
    if (out.join("\n") === text) {
      console.error(`Instance '${name}' not found`);
      process.exitCode = 1;
      return;
    }
    fs.writeFileSync(file, out.join("\n"), "utf8");
    console.log(`Instance '${name}' removed`);
  });
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
  .action(async () => {
    const fs = require("fs");
    const path = require("path");
    const cfgPath = path.resolve(process.cwd(), ".pgwatch-config");
    if (!fs.existsSync(cfgPath)) {
      console.error("Configuration file not found. Run 'quickstart' first.");
      process.exitCode = 1;
      return;
    }
    const content = fs.readFileSync(cfgPath, "utf8");
    const lines = content.split(/\r?\n/);
    let password = "";
    for (const line of lines) {
      const m = line.match(/^grafana_password=(.+)$/);
      if (m) {
        password = m[1].trim();
        break;
      }
    }
    if (!password) {
      console.error("Grafana password not found in configuration");
      process.exitCode = 1;
      return;
    }
    console.log("\nGrafana credentials:");
    console.log("  URL:      http://localhost:3000");
    console.log("  Username: monitor");
    console.log(`  Password: ${password}`);
    console.log("");
  });

program.parseAsync(process.argv);

 