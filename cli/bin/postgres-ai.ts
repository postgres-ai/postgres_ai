#!/usr/bin/env node

import { Command } from "commander";
import * as pkg from "../package.json";
import * as config from "../lib/config";
import * as yaml from "js-yaml";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { spawn, spawnSync, exec, execFile } from "child_process";
import { promisify } from "util";
import * as readline from "readline";
import * as http from "https";
import { URL } from "url";

const execPromise = promisify(exec);
const execFilePromise = promisify(execFile);

/**
 * CLI configuration options
 */
interface CliOptions {
  apiKey?: string;
  apiBaseUrl?: string;
  uiBaseUrl?: string;
}

/**
 * Configuration result
 */
interface ConfigResult {
  apiKey: string;
}

/**
 * Instance configuration
 */
interface Instance {
  name: string;
  conn_str?: string;
  preset_metrics?: string;
  custom_metrics?: any;
  is_enabled?: boolean;
  group?: string;
  custom_tags?: Record<string, any>;
}

/**
 * Path resolution result
 */
interface PathResolution {
  fs: typeof fs;
  path: typeof path;
  projectDir: string;
  composeFile: string;
  instancesFile: string;
}

/**
 * Health check service
 */
interface HealthService {
  name: string;
  url: string;
}

/**
 * Get configuration from various sources
 * @param opts - Command line options
 * @returns Configuration object
 */
function getConfig(opts: CliOptions): ConfigResult {
  // Priority order:
  // 1. Command line option (--api-key)
  // 2. Environment variable (PGAI_API_KEY)
  // 3. User-level config file (~/.config/postgresai/config.json)
  // 4. Legacy project-local config (.pgwatch-config)

  let apiKey = opts.apiKey || process.env.PGAI_API_KEY || "";

  // Try config file if not provided via CLI or env
  if (!apiKey) {
    const fileConfig = config.readConfig();
    if (!apiKey) apiKey = fileConfig.apiKey || "";
  }

  return { apiKey };
}

const program = new Command();

program
  .name("postgres-ai")
  .description("PostgresAI CLI")
  .version(pkg.version)
  .option("--api-key <key>", "API key (overrides PGAI_API_KEY)")
  .option(
    "--api-base-url <url>",
    "API base URL for backend RPC (overrides PGAI_API_BASE_URL)"
  )
  .option(
    "--ui-base-url <url>",
    "UI base URL for browser routes (overrides PGAI_UI_BASE_URL)"
  );

/**
 * Stub function for not implemented commands
 */
const stub = (name: string) => async (): Promise<void> => {
  // Temporary stubs until Node parity is implemented
  console.error(`${name}: not implemented in Node CLI yet; use bash CLI for now`);
  process.exitCode = 2;
};

/**
 * Resolve project paths
 */
function resolvePaths(): PathResolution {
  const projectDir = process.cwd();
  const composeFile = path.resolve(projectDir, "docker-compose.yml");
  const instancesFile = path.resolve(projectDir, "instances.yml");
  return { fs, path, projectDir, composeFile, instancesFile };
}

/**
 * Get docker compose command
 */
function getComposeCmd(): string[] | null {
  const tryCmd = (cmd: string, args: string[]): boolean =>
    spawnSync(cmd, args, { stdio: "ignore" }).status === 0;
  if (tryCmd("docker-compose", ["version"])) return ["docker-compose"];
  if (tryCmd("docker", ["compose", "version"])) return ["docker", "compose"];
  return null;
}

/**
 * Run docker compose command
 */
async function runCompose(args: string[]): Promise<number> {
  const { composeFile } = resolvePaths();
  const cmd = getComposeCmd();
  if (!cmd) {
    console.error("docker compose not found (need docker-compose or docker compose)");
    process.exitCode = 1;
    return 1;
  }
  return new Promise<number>((resolve) => {
    const child = spawn(cmd[0], [...cmd.slice(1), "-f", composeFile, ...args], { stdio: "inherit" });
    child.on("close", (code) => resolve(code || 0));
  });
}

program.command("help", { isDefault: true }).description("show help").action(() => {
  program.outputHelp();
});

// Monitoring services management
const mon = program.command("mon").description("monitoring services management");

mon
  .command("quickstart")
  .description("complete setup (generate config, start monitoring services)")
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

mon
  .command("start")
  .description("start monitoring services")
  .action(async () => {
    const code = await runCompose(["up", "-d"]);
    if (code !== 0) process.exitCode = code;
  });

mon
  .command("stop")
  .description("stop monitoring services")
  .action(async () => {
    const code = await runCompose(["down"]);
    if (code !== 0) process.exitCode = code;
  });

mon
  .command("restart [service]")
  .description("restart all monitoring services or specific service")
  .action(async (service?: string) => {
    const args = ["restart"];
    if (service) args.push(service);
    const code = await runCompose(args);
    if (code !== 0) process.exitCode = code;
  });

mon
  .command("status")
  .description("show monitoring services status")
  .action(async () => {
    const code = await runCompose(["ps"]);
    if (code !== 0) process.exitCode = code;
  });

mon
  .command("logs [service]")
  .option("-f, --follow", "follow logs", false)
  .option("--tail <lines>", "number of lines to show from the end of logs", "all")
  .description("show logs for all or specific monitoring service")
  .action(async (service: string | undefined, opts: { follow: boolean; tail: string }) => {
    const args: string[] = ["logs"];
    if (opts.follow) args.push("-f");
    if (opts.tail) args.push("--tail", opts.tail);
    if (service) args.push(service);
    const code = await runCompose(args);
    if (code !== 0) process.exitCode = code;
  });
mon
  .command("health")
  .description("health check for monitoring services")
  .option("--wait <seconds>", "wait time in seconds for services to become healthy", parseInt, 0)
  .action(async (opts: { wait: number }) => {
    const services: HealthService[] = [
      { name: "Grafana", url: "http://localhost:3000/api/health" },
      { name: "Prometheus", url: "http://localhost:59090/-/healthy" },
      { name: "PGWatch (Postgres)", url: "http://localhost:58080/health" },
      { name: "PGWatch (Prometheus)", url: "http://localhost:58089/health" },
    ];
    
    const waitTime = opts.wait || 0;
    const maxAttempts = waitTime > 0 ? Math.ceil(waitTime / 5) : 1;
    
    console.log("Checking service health...\n");
    
    let allHealthy = false;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (attempt > 1) {
        console.log(`Retrying (attempt ${attempt}/${maxAttempts})...\n`);
        await new Promise(resolve => setTimeout(resolve, 5000));
      }
      
      allHealthy = true;
      for (const service of services) {
        try {
          const { stdout } = await execPromise(
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
      
      if (allHealthy) {
        break;
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
mon
  .command("config")
  .description("show monitoring services configuration")
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
mon
  .command("update-config")
  .description("apply monitoring services configuration (generate sources)")
  .action(async () => {
    const code = await runCompose(["run", "--rm", "sources-generator"]);
    if (code !== 0) process.exitCode = code;
  });
mon
  .command("update")
  .description("update monitoring stack")
  .action(async () => {
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
        console.log("\nTo apply updates, restart monitoring services:");
        console.log("  postgres-ai mon restart");
      } else {
        console.error("\n✗ Docker image update failed");
        process.exitCode = 1;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Update failed: ${message}`);
      process.exitCode = 1;
    }
  });
mon
  .command("reset [service]")
  .description("reset all or specific monitoring service")
  .action(async (service?: string) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    
    const question = (prompt: string): Promise<string> =>
      new Promise((resolve) => rl.question(prompt, resolve));
    
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
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Reset failed: ${message}`);
      process.exitCode = 1;
    }
  });
mon
  .command("clean")
  .description("cleanup monitoring services artifacts")
  .action(async () => {
    console.log("Cleaning up Docker resources...\n");
    
    try {
      // Remove stopped containers
      const { stdout: containers } = await execFilePromise("docker", ["ps", "-aq", "--filter", "status=exited"]);
      if (containers.trim()) {
        const containerIds = containers.trim().split('\n');
        await execFilePromise("docker", ["rm", ...containerIds]);
        console.log("✓ Removed stopped containers");
      } else {
        console.log("✓ No stopped containers to remove");
      }
      
      // Remove unused volumes
      await execFilePromise("docker", ["volume", "prune", "-f"]);
      console.log("✓ Removed unused volumes");
      
      // Remove unused networks
      await execFilePromise("docker", ["network", "prune", "-f"]);
      console.log("✓ Removed unused networks");
      
      // Remove dangling images
      await execFilePromise("docker", ["image", "prune", "-f"]);
      console.log("✓ Removed dangling images");
      
      console.log("\nCleanup completed");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Error during cleanup: ${message}`);
      process.exitCode = 1;
    }
  });
mon
  .command("shell <service>")
  .description("open shell to monitoring service")
  .action(async (service: string) => {
    const code = await runCompose(["exec", service, "/bin/sh"]);
    if (code !== 0) process.exitCode = code;
  });
mon
  .command("check")
  .description("monitoring services system readiness check")
  .action(async () => {
    const code = await runCompose(["ps"]);
    if (code !== 0) process.exitCode = code;
  });

// Monitoring targets (databases to monitor)
const targets = mon.command("targets").description("manage databases to monitor");

targets
  .command("list")
  .description("list monitoring target databases")
  .action(async () => {
    const instancesPath = path.resolve(process.cwd(), "instances.yml");
    if (!fs.existsSync(instancesPath)) {
      console.error(`instances.yml not found in ${process.cwd()}`);
      process.exitCode = 1;
      return;
    }
    
    try {
      const content = fs.readFileSync(instancesPath, "utf8");
      const instances = yaml.load(content) as Instance[] | null;
      
      if (!instances || !Array.isArray(instances) || instances.length === 0) {
        console.log("No monitoring targets configured");
        console.log("");
        console.log("To add a monitoring target:");
        console.log("  postgres-ai mon targets add <connection-string> <name>");
        console.log("");
        console.log("Example:");
        console.log("  postgres-ai mon targets add 'postgresql://user:pass@host:5432/db' my-db");
        return;
      }
      
      // Filter out demo placeholder
      const filtered = instances.filter((inst) => inst.name && inst.name !== "target-database");
      
      if (filtered.length === 0) {
        console.log("No monitoring targets configured");
        console.log("");
        console.log("To add a monitoring target:");
        console.log("  postgres-ai mon targets add <connection-string> <name>");
        console.log("");
        console.log("Example:");
        console.log("  postgres-ai mon targets add 'postgresql://user:pass@host:5432/db' my-db");
        return;
      }
      
      for (const inst of filtered) {
        console.log(`Target: ${inst.name}`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`Error parsing instances.yml: ${message}`);
      process.exitCode = 1;
    }
  });
targets
  .command("add [connStr] [name]")
  .description("add monitoring target database")
  .action(async (connStr?: string, name?: string) => {
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
    
    // Check if instance already exists
    try {
      if (fs.existsSync(file)) {
        const content = fs.readFileSync(file, "utf8");
        const instances = yaml.load(content) as Instance[] | null || [];
        if (Array.isArray(instances)) {
          const exists = instances.some((inst) => inst.name === instanceName);
          if (exists) {
            console.error(`Monitoring target '${instanceName}' already exists`);
            process.exitCode = 1;
            return;
          }
        }
      }
    } catch (err) {
      // If YAML parsing fails, fall back to simple check
      const content = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
      if (new RegExp(`^- name: ${instanceName}$`, "m").test(content)) {
        console.error(`Monitoring target '${instanceName}' already exists`);
        process.exitCode = 1;
        return;
      }
    }
    
    // Add new instance
    const body = `- name: ${instanceName}\n  conn_str: ${connStr}\n  preset_metrics: full\n  custom_metrics:\n  is_enabled: true\n  group: default\n  custom_tags:\n    env: production\n    cluster: default\n    node_name: ${instanceName}\n    sink_type: ~sink_type~\n`;
    const content = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
    fs.appendFileSync(file, (content && !/\n$/.test(content) ? "\n" : "") + body, "utf8");
    console.log(`Monitoring target '${instanceName}' added`);
  });
targets
  .command("remove <name>")
  .description("remove monitoring target database")
  .action(async (name: string) => {
    const file = path.resolve(process.cwd(), "instances.yml");
    if (!fs.existsSync(file)) {
      console.error("instances.yml not found");
      process.exitCode = 1;
      return;
    }
    
    try {
      const content = fs.readFileSync(file, "utf8");
      const instances = yaml.load(content) as Instance[] | null;
      
      if (!instances || !Array.isArray(instances)) {
        console.error("Invalid instances.yml format");
        process.exitCode = 1;
        return;
      }
      
      const filtered = instances.filter((inst) => inst.name !== name);
      
      if (filtered.length === instances.length) {
        console.error(`Monitoring target '${name}' not found`);
        process.exitCode = 1;
        return;
      }
      
      fs.writeFileSync(file, yaml.dump(filtered), "utf8");
      console.log(`Monitoring target '${name}' removed`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`Error processing instances.yml: ${message}`);
      process.exitCode = 1;
    }
  });
targets
  .command("test <name>")
  .description("test monitoring target database connectivity")
  .action(async (name: string) => {
    const instancesPath = path.resolve(process.cwd(), "instances.yml");
    if (!fs.existsSync(instancesPath)) {
      console.error("instances.yml not found");
      process.exitCode = 1;
      return;
    }
    
    try {
      const content = fs.readFileSync(instancesPath, "utf8");
      const instances = yaml.load(content) as Instance[] | null;
      
      if (!instances || !Array.isArray(instances)) {
        console.error("Invalid instances.yml format");
        process.exitCode = 1;
        return;
      }
      
      const instance = instances.find((inst) => inst.name === name);
      
      if (!instance) {
        console.error(`Monitoring target '${name}' not found`);
        process.exitCode = 1;
        return;
      }
      
      if (!instance.conn_str) {
        console.error(`Connection string not found for monitoring target '${name}'`);
        process.exitCode = 1;
        return;
      }
      
      console.log(`Testing connection to monitoring target '${name}'...`);
      
      const { stdout, stderr } = await execFilePromise(
        "psql",
        [instance.conn_str, "-c", "SELECT version();", "--no-psqlrc"],
        { timeout: 10000, env: { ...process.env, PAGER: 'cat' } }
      );
      console.log(`✓ Connection successful`);
      console.log(stdout.trim());
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`✗ Connection failed: ${message}`);
      process.exitCode = 1;
    }
  });

// Authentication and API key management
program
  .command("auth")
  .description("authenticate via browser and obtain API key")
  .option("--port <port>", "local callback server port (default: random)", parseInt)
  .option("--debug", "enable debug output")
  .action(async (opts: { port?: number; debug?: boolean }) => {
    const pkce = require("../lib/pkce");
    const authServer = require("../lib/auth-server");
    
    console.log("Starting authentication flow...\n");
    
    // Generate PKCE parameters
    const params = pkce.generatePKCEParams();

    const rootOpts = program.opts<CliOptions>();

    const apiBaseUrl = (rootOpts.apiBaseUrl || process.env.PGAI_API_BASE_URL || "https://postgres.ai/api/general/").replace(/\/$/, "");
    const uiBaseUrl = (rootOpts.uiBaseUrl || process.env.PGAI_UI_BASE_URL || "https://console.postgres.ai").replace(/\/$/, "");
    
    if (opts.debug) {
      console.log(`Debug: Resolved API base URL: ${apiBaseUrl}`);
      console.log(`Debug: Resolved UI base URL: ${uiBaseUrl}`);
    }
    
    try {
      // Step 1: Start local callback server FIRST to get actual port
      console.log("Starting local callback server...");
      const requestedPort = opts.port || 0; // 0 = OS assigns available port
      const callbackServer = authServer.createCallbackServer(requestedPort, params.state, 300000);
      
      // Wait a bit for server to start and get port
      await new Promise(resolve => setTimeout(resolve, 100));
      const actualPort = callbackServer.getPort();
      const redirectUri = `http://localhost:${actualPort}/callback`;
      
      console.log(`Callback server listening on port ${actualPort}`);
      
      // Step 2: Initialize OAuth session on backend
      console.log("Initializing authentication session...");
      const initData = JSON.stringify({
        client_type: "cli",
        state: params.state,
        code_challenge: params.codeChallenge,
        code_challenge_method: params.codeChallengeMethod,
        redirect_uri: redirectUri,
      });
      
      // Build init URL by appending to the API base path (keep /api/general)
      const initUrl = new URL(`${apiBaseUrl}/rpc/oauth_init`);
      
      if (opts.debug) {
        console.log(`Debug: Trying to POST to: ${initUrl.toString()}`);
        console.log(`Debug: Request data: ${initData}`);
      }
      
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
              callbackServer.server.close();
              process.exitCode = 1;
              return;
            }
            
            // Step 3: Open browser
            const authUrl = `${uiBaseUrl}/cli/auth?state=${encodeURIComponent(params.state)}&code_challenge=${encodeURIComponent(params.codeChallenge)}&code_challenge_method=S256&redirect_uri=${encodeURIComponent(redirectUri)}`;
            
            if (opts.debug) {
              console.log(`Debug: Auth URL: ${authUrl}`);
            }
            
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
              const { code } = await callbackServer.promise;
              
              // Step 5: Exchange code for token
              console.log("\nExchanging authorization code for API token...");
              const exchangeData = JSON.stringify({
                authorization_code: code,
                code_verifier: params.codeVerifier,
                state: params.state,
              });
              const exchangeUrl = new URL(`${apiBaseUrl}/rpc/oauth_token_exchange`);
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
                  let exchangeBody = "";
                  exchangeRes.on("data", (chunk) => (exchangeBody += chunk));
                  exchangeRes.on("end", () => {
                    if (exchangeRes.statusCode !== 200) {
                      console.error(`Failed to exchange code for token: ${exchangeRes.statusCode}`);
                      console.error(exchangeBody);
                      process.exit(1);
                      return;
                    }
                    
                    try {
                      const result = JSON.parse(exchangeBody);
                      const apiToken = result.api_token || result?.[0]?.result?.api_token; // There is a bug with PostgREST Caching that may return an array, not single object, it's a workaround to support both cases.
                      const orgId = result.org_id || result?.[0]?.result?.org_id; // There is a bug with PostgREST Caching that may return an array, not single object, it's a workaround to support both cases.
                      
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
                      process.exit(0);
                    } catch (err) {
                      const message = err instanceof Error ? err.message : String(err);
                      console.error(`Failed to parse response: ${message}`);
                      process.exit(1);
                    }
                  });
                }
              );
              
              exchangeReq.on("error", (err: Error) => {
                console.error(`Exchange request failed: ${err.message}`);
                process.exit(1);
              });
              
              exchangeReq.write(exchangeData);
              exchangeReq.end();
              
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              console.error(`\nAuthentication failed: ${message}`);
              process.exit(1);
            }
          });
        }
      );
      
      initReq.on("error", (err: Error) => {
        console.error(`Failed to connect to API: ${err.message}`);
        callbackServer.server.close();
        process.exit(1);
      });
      
      initReq.write(initData);
      initReq.end();
      
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`Authentication error: ${message}`);
      process.exit(1);
    }
  });

program
  .command("add-key <apiKey>")
  .description("store API key")
  .action(async (apiKey: string) => {
    config.writeConfig({ apiKey });
    console.log(`API key saved to ${config.getConfigPath()}`);
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
    const mask = (k: string): string => {
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
    // Check both new config and legacy config
    const newConfigPath = config.getConfigPath();
    const hasNewConfig = fs.existsSync(newConfigPath);
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
      try {
        const content = fs.readFileSync(legacyPath, "utf8");
        const filtered = content
          .split(/\r?\n/)
          .filter((l) => !/^api_key=/.test(l))
          .join("\n")
          .replace(/\n+$/g, "\n");
        fs.writeFileSync(legacyPath, filtered, "utf8");
      } catch (err) {
        // If we can't read/write the legacy config, just skip it
        console.warn(`Warning: Could not update legacy config: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    
    console.log("API key removed");
    console.log(`\nTo authenticate again, run: pgai auth`);
  });
mon
  .command("generate-grafana-password")
  .description("generate Grafana password for monitoring services")
  .action(async () => {
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
      let configContent = "";
      if (fs.existsSync(cfgPath)) {
        const stats = fs.statSync(cfgPath);
        if (stats.isDirectory()) {
          console.error(".pgwatch-config is a directory, expected a file. Skipping read.");
        } else {
          configContent = fs.readFileSync(cfgPath, "utf8");
        }
      }
      
      // Update or add grafana_password
      const lines = configContent.split(/\r?\n/).filter((l) => !/^grafana_password=/.test(l));
      lines.push(`grafana_password=${newPassword}`);
      
      // Write back
      fs.writeFileSync(cfgPath, lines.filter(Boolean).join("\n") + "\n", "utf8");
      
      console.log("✓ New Grafana password generated and saved");
      console.log("\nNew credentials:");
      console.log("  URL:      http://localhost:3000");
      console.log("  Username: monitor");
      console.log(`  Password: ${newPassword}`);
      console.log("\nRestart Grafana to apply:");
      console.log("  postgres-ai mon restart grafana");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Failed to generate password: ${message}`);
      console.error("\nNote: This command requires 'openssl' to be installed");
      process.exitCode = 1;
    }
  });
mon
  .command("show-grafana-credentials")
  .description("show Grafana credentials for monitoring services")
  .action(async () => {
    const cfgPath = path.resolve(process.cwd(), ".pgwatch-config");
    if (!fs.existsSync(cfgPath)) {
      console.error("Configuration file not found. Run 'postgres-ai mon quickstart' first.");
      process.exitCode = 1;
      return;
    }
    
    const stats = fs.statSync(cfgPath);
    if (stats.isDirectory()) {
      console.error(".pgwatch-config is a directory, expected a file. Cannot read credentials.");
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

