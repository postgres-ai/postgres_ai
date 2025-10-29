#!/usr/bin/env node
"use strict";

const { Command } = require("commander");
const pkg = require("../package.json");
const config = require("../lib/config");

function getConfig(opts) {
  // Priority order:
  // 1. Command line option (--api-key)
  // 2. Environment variable (PGAI_API_KEY)
  // 3. User-level config file (~/.config/postgresai/config.json)
  // 4. Legacy project-local config (.pgwatch-config)
  
  let apiKey = opts.apiKey || process.env.PGAI_API_KEY || "";
  let baseUrl = opts.baseUrl || process.env.PGAI_BASE_URL || "";
  
  // Try config file if not provided via CLI or env
  if (!apiKey || !baseUrl) {
    const fileConfig = config.readConfig();
    if (!apiKey) apiKey = fileConfig.apiKey || "";
    if (!baseUrl) baseUrl = fileConfig.baseUrl || "";
  }
  
  // Default base URL
  if (!baseUrl) {
    baseUrl = "https://postgres.ai/api/general/";
  }
  
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
program
  .command("update")
  .description("update project")
  .action(async () => {
    const { exec } = require("child_process");
    const util = require("util");
    const execPromise = util.promisify(exec);
    const fs = require("fs");
    const path = require("path");
    
    console.log("Updating PostgresAI monitoring stack...\n");
    
    try {
      // Check if we're in a git repo
      const gitDir = path.resolve(process.cwd(), ".git");
      if (!fs.existsSync(gitDir)) {
        console.error("Not a git repository. Cannot update.");
        process.exitCode = 1;
        return;
      }
      
      // Fetch latest changes
      console.log("Fetching latest changes...");
      await execPromise("git fetch origin");
      
      // Check current branch
      const { stdout: branch } = await execPromise("git rev-parse --abbrev-ref HEAD");
      const currentBranch = branch.trim();
      console.log(`Current branch: ${currentBranch}`);
      
      // Pull latest changes
      console.log("Pulling latest changes...");
      const { stdout: pullOut } = await execPromise("git pull origin " + currentBranch);
      console.log(pullOut);
      
      // Update Docker images
      console.log("\nUpdating Docker images...");
      const code = await runCompose(["pull"]);
      
      if (code === 0) {
        console.log("\n✓ Update completed successfully");
        console.log("\nTo apply updates, restart services:");
        console.log("  postgres-ai restart");
      } else {
        console.error("\n✗ Docker image update failed");
        process.exitCode = 1;
      }
    } catch (error) {
      console.error(`Update failed: ${error.message}`);
      process.exitCode = 1;
    }
  });
program
  .command("reset [service]")
  .description("reset all or specific service")
  .action(async (service) => {
    const readline = require("readline");
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    
    const question = (prompt) => new Promise((resolve) => rl.question(prompt, resolve));
    
    try {
      if (service) {
        // Reset specific service
        console.log(`\nThis will stop '${service}', remove its volume, and restart it.`);
        console.log("All data for this service will be lost!\n");
        
        const answer = await question("Continue? (y/N): ");
        if (answer.toLowerCase() !== "y") {
          console.log("Cancelled");
          rl.close();
          return;
        }
        
        console.log(`\nStopping ${service}...`);
        await runCompose(["stop", service]);
        
        console.log(`Removing volume for ${service}...`);
        await runCompose(["rm", "-f", "-v", service]);
        
        console.log(`Restarting ${service}...`);
        const code = await runCompose(["up", "-d", service]);
        
        if (code === 0) {
          console.log(`\n✓ Service '${service}' has been reset`);
        } else {
          console.error(`\n✗ Failed to restart '${service}'`);
          process.exitCode = 1;
        }
      } else {
        // Reset all services
        console.log("\nThis will stop all services and remove all data!");
        console.log("Volumes, networks, and containers will be deleted.\n");
        
        const answer = await question("Continue? (y/N): ");
        if (answer.toLowerCase() !== "y") {
          console.log("Cancelled");
          rl.close();
          return;
        }
        
        console.log("\nStopping services and removing data...");
        const downCode = await runCompose(["down", "-v"]);
        
        if (downCode === 0) {
          console.log("✓ Environment reset completed - all containers and data removed");
        } else {
          console.error("✗ Reset failed");
          process.exitCode = 1;
        }
      }
      
      rl.close();
    } catch (error) {
      rl.close();
      console.error(`Reset failed: ${error.message}`);
      process.exitCode = 1;
    }
  });
program
  .command("clean")
  .description("cleanup artifacts")
  .action(async () => {
    const { exec } = require("child_process");
    const util = require("util");
    const execPromise = util.promisify(exec);
    
    console.log("Cleaning up Docker resources...\n");
    
    try {
      // Remove stopped containers
      const { stdout: containers } = await execPromise("docker ps -aq --filter 'status=exited'");
      if (containers.trim()) {
        await execPromise(`docker rm ${containers.trim().split('\n').join(' ')}`);
        console.log("✓ Removed stopped containers");
      } else {
        console.log("✓ No stopped containers to remove");
      }
      
      // Remove unused volumes
      const { stdout: volumeOut } = await execPromise("docker volume prune -f");
      console.log("✓ Removed unused volumes");
      
      // Remove unused networks
      const { stdout: networkOut } = await execPromise("docker network prune -f");
      console.log("✓ Removed unused networks");
      
      // Remove dangling images
      const { stdout: imageOut } = await execPromise("docker image prune -f");
      console.log("✓ Removed dangling images");
      
      console.log("\nCleanup completed");
    } catch (error) {
      console.error(`Error during cleanup: ${error.message}`);
      process.exitCode = 1;
    }
  });
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
  .action(async (name) => {
    const fs = require("fs");
    const path = require("path");
    const { exec } = require("child_process");
    const util = require("util");
    const execPromise = util.promisify(exec);
    
    const instancesPath = path.resolve(process.cwd(), "instances.yml");
    if (!fs.existsSync(instancesPath)) {
      console.error("instances.yml not found");
      process.exitCode = 1;
      return;
    }
    
    const content = fs.readFileSync(instancesPath, "utf8");
    const lines = content.split(/\r?\n/);
    let connStr = "";
    let foundInstance = false;
    
    for (let i = 0; i < lines.length; i++) {
      const nameLine = lines[i].match(/^-[\t ]*name:[\t ]*(.+)$/);
      if (nameLine && nameLine[1].trim() === name) {
        foundInstance = true;
        // Look for conn_str in next lines
        for (let j = i + 1; j < lines.length && j < i + 15; j++) {
          const connLine = lines[j].match(/^[\t ]*conn_str:[\t ]*(.+)$/);
          if (connLine) {
            connStr = connLine[1].trim();
            break;
          }
          // Stop at next instance
          if (lines[j].match(/^-[\t ]*name:/)) break;
        }
        break;
      }
    }
    
    if (!foundInstance) {
      console.error(`Instance '${name}' not found`);
      process.exitCode = 1;
      return;
    }
    
    if (!connStr) {
      console.error(`Connection string not found for instance '${name}'`);
      process.exitCode = 1;
      return;
    }
    
    console.log(`Testing connection to '${name}'...`);
    
    try {
      const { stdout, stderr } = await execPromise(
        `psql "${connStr}" -c "SELECT version();" --no-psqlrc`,
        { timeout: 10000, env: { ...process.env, PAGER: 'cat' } }
      );
      console.log(`✓ Connection successful`);
      console.log(stdout.trim());
    } catch (error) {
      console.error(`✗ Connection failed: ${error.message}`);
      process.exitCode = 1;
    }
  });

// Authentication and API key management
program
  .command("auth")
  .description("authenticate via browser and obtain API key")
  .option("--port <port>", "local callback server port (default: random)", parseInt)
  .action(async (opts) => {
    const pkce = require("../lib/pkce");
    const authServer = require("../lib/auth-server");
    const { spawn } = require("child_process");
    const http = require("https");
    
    console.log("Starting authentication flow...\n");
    
    // Generate PKCE parameters
    const params = pkce.generatePKCEParams();
    const port = opts.port || 8585;
    const redirectUri = `http://localhost:${port}/callback`;
    
    const cfg = getConfig(program.opts());
    const baseUrl = cfg.baseUrl || "https://postgres.ai/api/general/";
    const apiBaseUrl = baseUrl.replace(/\/$/, "");
    
    // Step 1: Initialize OAuth session on backend
    console.log("Initializing authentication session...");
    const initData = JSON.stringify({
      client_type: "cli",
      state: params.state,
      code_challenge: params.codeChallenge,
      code_challenge_method: params.codeChallengeMethod,
      redirect_uri: redirectUri,
    });
    
    try {
      const initUrl = new URL("/rpc/oauth_init", apiBaseUrl);
      const initReq = http.request(
        initUrl,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(initData),
          },
        },
        (res) => {
          let data = "";
          res.on("data", (chunk) => (data += chunk));
          res.on("end", async () => {
            if (res.statusCode !== 200) {
              console.error(`Failed to initialize auth session: ${res.statusCode}`);
              console.error(data);
              process.exitCode = 1;
              return;
            }
            
            // Step 2: Start local callback server
            console.log("Starting local callback server...");
            const serverPromise = authServer.startCallbackServer(port, params.state, 300000);
            
            // Step 3: Open browser
            const webUrl = apiBaseUrl.replace(/\/api\/general\/?$/, "");
            const authUrl = `${webUrl}/cli/auth?state=${encodeURIComponent(params.state)}&code_challenge=${encodeURIComponent(params.codeChallenge)}&code_challenge_method=S256&redirect_uri=${encodeURIComponent(redirectUri)}`;
            
            console.log(`\nOpening browser for authentication...`);
            console.log(`If browser does not open automatically, visit:\n${authUrl}\n`);
            
            // Open browser (cross-platform)
            const openCommand = process.platform === "darwin" ? "open" :
                               process.platform === "win32" ? "start" :
                               "xdg-open";
            spawn(openCommand, [authUrl], { detached: true, stdio: "ignore" }).unref();
            
            // Step 4: Wait for callback
            console.log("Waiting for authorization...");
            try {
              const { code } = await serverPromise;
              
              // Step 5: Exchange code for token
              console.log("\nExchanging authorization code for API token...");
              const exchangeData = JSON.stringify({
                authorization_code: code,
                code_verifier: params.codeVerifier,
                state: params.state,
              });
              
              const exchangeUrl = new URL("/rpc/oauth_token_exchange", apiBaseUrl);
              const exchangeReq = http.request(
                exchangeUrl,
                {
                  method: "POST",
                  headers: {
                    "Content-Type": "application/json",
                    "Content-Length": Buffer.byteLength(exchangeData),
                  },
                },
                (exchangeRes) => {
                  let exchangeData = "";
                  exchangeRes.on("data", (chunk) => (exchangeData += chunk));
                  exchangeRes.on("end", () => {
                    if (exchangeRes.statusCode !== 200) {
                      console.error(`Failed to exchange code for token: ${exchangeRes.statusCode}`);
                      console.error(exchangeData);
                      process.exitCode = 1;
                      return;
                    }
                    
                    try {
                      const result = JSON.parse(exchangeData);
                      const apiToken = result.api_token;
                      const orgId = result.org_id;
                      
                      // Step 6: Save token to config
                      config.writeConfig({
                        apiKey: apiToken,
                        baseUrl: apiBaseUrl,
                        orgId: orgId,
                      });
                      
                      console.log("\nAuthentication successful!");
                      console.log(`API key saved to: ${config.getConfigPath()}`);
                      console.log(`Organization ID: ${orgId}`);
                      console.log(`\nYou can now use the CLI without specifying an API key.`);
                    } catch (err) {
                      console.error(`Failed to parse response: ${err.message}`);
                      process.exitCode = 1;
                    }
                  });
                }
              );
              
              exchangeReq.on("error", (err) => {
                console.error(`Exchange request failed: ${err.message}`);
                process.exitCode = 1;
              });
              
              exchangeReq.write(exchangeData);
              exchangeReq.end();
              
            } catch (err) {
              console.error(`\nAuthentication failed: ${err.message}`);
              process.exitCode = 1;
            }
          });
        }
      );
      
      initReq.on("error", (err) => {
        console.error(`Failed to connect to API: ${err.message}`);
        process.exitCode = 1;
      });
      
      initReq.write(initData);
      initReq.end();
      
    } catch (err) {
      console.error(`Authentication error: ${err.message}`);
      process.exitCode = 1;
    }
  });

program
  .command("add-key <apiKey>")
  .description("store API key")
  .action(async (apiKey) => {
    const fs = require("fs");
    const path = require("path");
    const cfgPath = path.resolve(process.cwd(), ".pgwatch-config");
    
    // Check if it exists and is a file (not a directory)
    let existing = "";
    if (fs.existsSync(cfgPath)) {
      const stats = fs.statSync(cfgPath);
      if (stats.isFile()) {
        existing = fs.readFileSync(cfgPath, "utf8");
      } else if (stats.isDirectory()) {
        // Remove directory and recreate as file
        fs.rmSync(cfgPath, { recursive: true, force: true });
      }
    }
    
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
    const cfg = config.readConfig();
    if (!cfg.apiKey) {
      console.log("No API key configured");
      console.log(`\nTo authenticate, run: pgai auth`);
      return;
    }
    const mask = (k) => {
      if (k.length <= 8) return "****";
      if (k.length <= 16) return `${k.slice(0, 4)}${"*".repeat(k.length - 8)}${k.slice(-4)}`;
      // For longer keys, show more of the beginning to help identify them
      return `${k.slice(0, Math.min(12, k.length - 8))}${"*".repeat(Math.max(4, k.length - 16))}${k.slice(-4)}`;
    };
    console.log(`Current API key: ${mask(cfg.apiKey)}`);
    if (cfg.orgId) {
      console.log(`Organization ID: ${cfg.orgId}`);
    }
    console.log(`Config location: ${config.getConfigPath()}`);
  });

program
  .command("remove-key")
  .description("remove API key")
  .action(async () => {
    const fs = require("fs");
    const path = require("path");
    
    // Check both new config and legacy config
    const hasNewConfig = config.configExists();
    const legacyPath = path.resolve(process.cwd(), ".pgwatch-config");
    const hasLegacyConfig = fs.existsSync(legacyPath) && fs.statSync(legacyPath).isFile();
    
    if (!hasNewConfig && !hasLegacyConfig) {
      console.log("No API key configured");
      return;
    }
    
    // Remove from new config
    if (hasNewConfig) {
      config.deleteConfigKeys(["apiKey", "orgId"]);
    }
    
    // Remove from legacy config
    if (hasLegacyConfig) {
      const content = fs.readFileSync(legacyPath, "utf8");
      const filtered = content
        .split(/\r?\n/)
        .filter((l) => !/^api_key=/.test(l))
        .join("\n")
        .replace(/\n+$/g, "\n");
      fs.writeFileSync(legacyPath, filtered, "utf8");
    }
    
    console.log("API key removed");
    console.log(`\nTo authenticate again, run: pgai auth`);
  });
program
  .command("generate-grafana-password")
  .description("generate Grafana password")
  .action(async () => {
    const fs = require("fs");
    const path = require("path");
    const { exec } = require("child_process");
    const util = require("util");
    const execPromise = util.promisify(exec);
    
    const cfgPath = path.resolve(process.cwd(), ".pgwatch-config");
    
    try {
      // Generate secure password using openssl
      const { stdout: password } = await execPromise(
        "openssl rand -base64 12 | tr -d '\n'"
      );
      const newPassword = password.trim();
      
      if (!newPassword) {
        console.error("Failed to generate password");
        process.exitCode = 1;
        return;
      }
      
      // Read existing config
      let config = "";
      if (fs.existsSync(cfgPath)) {
        config = fs.readFileSync(cfgPath, "utf8");
      }
      
      // Update or add grafana_password
      const lines = config.split(/\r?\n/).filter((l) => !/^grafana_password=/.test(l));
      lines.push(`grafana_password=${newPassword}`);
      
      // Write back
      fs.writeFileSync(cfgPath, lines.filter(Boolean).join("\n") + "\n", "utf8");
      
      console.log("✓ New Grafana password generated and saved");
      console.log("\nNew credentials:");
      console.log("  URL:      http://localhost:3000");
      console.log("  Username: monitor");
      console.log(`  Password: ${newPassword}`);
      console.log("\nRestart Grafana to apply:");
      console.log("  postgres-ai restart grafana");
    } catch (error) {
      console.error(`Failed to generate password: ${error.message}`);
      console.error("\nNote: This command requires 'openssl' to be installed");
      process.exitCode = 1;
    }
  });
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

 