#!/usr/bin/env bun

import { Command } from "commander";
import pkg from "../package.json";
import * as config from "../lib/config";
import * as yaml from "js-yaml";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { Client } from "pg";
import { startMcpServer } from "../lib/mcp-server";
import { fetchIssues, fetchIssueComments, createIssueComment, fetchIssue } from "../lib/issues";
import { resolveBaseUrls } from "../lib/util";
import { applyInitPlan, buildInitPlan, connectWithSslFallback, DEFAULT_MONITORING_USER, redactPasswordsInSql, resolveAdminConnection, resolveMonitoringPassword, verifyInitSetup } from "../lib/init";
import * as pkce from "../lib/pkce";
import * as authServer from "../lib/auth-server";
import { maskSecret } from "../lib/util";
import { createInterface } from "readline";
import * as childProcess from "child_process";
import { REPORT_GENERATORS, CHECK_INFO, generateAllReports } from "../lib/checkup";

// Singleton readline interface for stdin prompts
let rl: ReturnType<typeof createInterface> | null = null;
function getReadline() {
  if (!rl) {
    rl = createInterface({ input: process.stdin, output: process.stdout });
  }
  return rl;
}
function closeReadline() {
  if (rl) {
    rl.close();
    rl = null;
  }
}

// Helper functions for spawning processes - use Node.js child_process for compatibility
async function execPromise(command: string): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    childProcess.exec(command, (error, stdout, stderr) => {
      if (error) {
        const err = error as Error & { code: number };
        err.code = error.code ?? 1;
        reject(err);
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

async function execFilePromise(file: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    childProcess.execFile(file, args, (error, stdout, stderr) => {
      if (error) {
        const err = error as Error & { code: number };
        err.code = error.code ?? 1;
        reject(err);
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

function spawnSync(cmd: string, args: string[], options?: { stdio?: "pipe" | "ignore" | "inherit"; encoding?: string; env?: Record<string, string | undefined>; cwd?: string }): { status: number | null; stdout: string; stderr: string } {
  const result = childProcess.spawnSync(cmd, args, {
    stdio: options?.stdio === "inherit" ? "inherit" : "pipe",
    env: options?.env as NodeJS.ProcessEnv,
    cwd: options?.cwd,
    encoding: "utf8",
  });
  return {
    status: result.status,
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    stderr: typeof result.stderr === "string" ? result.stderr : "",
  };
}

function spawn(cmd: string, args: string[], options?: { stdio?: "pipe" | "ignore" | "inherit"; env?: Record<string, string | undefined>; cwd?: string; detached?: boolean }): { on: (event: string, cb: (code: number | null, signal?: string) => void) => void; unref: () => void; pid?: number } {
  const proc = childProcess.spawn(cmd, args, {
    stdio: options?.stdio ?? "pipe",
    env: options?.env as NodeJS.ProcessEnv,
    cwd: options?.cwd,
    detached: options?.detached,
  });

  return {
    on(event: string, cb: (code: number | null, signal?: string) => void) {
      if (event === "close" || event === "exit") {
        proc.on(event, (code, signal) => cb(code, signal ?? undefined));
      } else if (event === "error") {
        proc.on("error", (err) => cb(null, String(err)));
      }
      return this;
    },
    unref() {
      proc.unref();
    },
    pid: proc.pid,
  };
}

// Simple readline-like interface for prompts using Bun
async function question(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    getReadline().question(prompt, (answer) => {
      resolve(answer);
    });
  });
}

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

function getDefaultMonitoringProjectDir(): string {
  const override = process.env.PGAI_PROJECT_DIR;
  if (override && override.trim()) return override.trim();
  // Keep monitoring project next to user-level config (~/.config/postgresai)
  return path.join(config.getConfigDir(), "monitoring");
}

async function downloadText(url: string): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} for ${url}`);
    }
    return await response.text();
  } finally {
    clearTimeout(timeout);
  }
}

async function ensureDefaultMonitoringProject(): Promise<PathResolution> {
  const projectDir = getDefaultMonitoringProjectDir();
  const composeFile = path.resolve(projectDir, "docker-compose.yml");
  const instancesFile = path.resolve(projectDir, "instances.yml");

  if (!fs.existsSync(projectDir)) {
    fs.mkdirSync(projectDir, { recursive: true, mode: 0o700 });
  }

  if (!fs.existsSync(composeFile)) {
    const refs = [
      process.env.PGAI_PROJECT_REF,
      pkg.version,
      `v${pkg.version}`,
      "main",
    ].filter((v): v is string => Boolean(v && v.trim()));

    let lastErr: unknown;
    for (const ref of refs) {
      const url = `https://gitlab.com/postgres-ai/postgres_ai/-/raw/${encodeURIComponent(ref)}/docker-compose.yml`;
      try {
        const text = await downloadText(url);
        fs.writeFileSync(composeFile, text, { encoding: "utf8", mode: 0o600 });
        break;
      } catch (err) {
        lastErr = err;
      }
    }

    if (!fs.existsSync(composeFile)) {
      const msg = lastErr instanceof Error ? lastErr.message : String(lastErr);
      throw new Error(`Failed to bootstrap docker-compose.yml: ${msg}`);
    }
  }

  // Ensure instances.yml exists as a FILE (avoid Docker creating a directory)
  if (!fs.existsSync(instancesFile)) {
    const header =
      "# PostgreSQL instances to monitor\n" +
      "# Add your instances using: pgai mon targets add <connection-string> <name>\n\n";
    fs.writeFileSync(instancesFile, header, { encoding: "utf8", mode: 0o600 });
  }

  // Ensure .pgwatch-config exists as a FILE for reporter (may remain empty)
  const pgwatchConfig = path.resolve(projectDir, ".pgwatch-config");
  if (!fs.existsSync(pgwatchConfig)) {
    fs.writeFileSync(pgwatchConfig, "", { encoding: "utf8", mode: 0o600 });
  }

  // Ensure .env exists and has PGAI_TAG (compose requires it)
  const envFile = path.resolve(projectDir, ".env");
  if (!fs.existsSync(envFile)) {
    const envText = `PGAI_TAG=${pkg.version}\n# PGAI_REGISTRY=registry.gitlab.com/postgres-ai/postgres_ai\n`;
    fs.writeFileSync(envFile, envText, { encoding: "utf8", mode: 0o600 });
  }

  return { fs, path, projectDir, composeFile, instancesFile };
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

// Human-friendly output helper: YAML for TTY by default, JSON when --json or non-TTY
function printResult(result: unknown, json?: boolean): void {
  if (typeof result === "string") {
    process.stdout.write(result);
    if (!/\n$/.test(result)) console.log();
    return;
  }
  if (json || !process.stdout.isTTY) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    let text = yaml.dump(result as any);
    if (Array.isArray(result)) {
      text = text.replace(/\n- /g, "\n\n- ");
    }
    console.log(text);
  }
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

program
  .command("prepare-db [conn]")
  .description("prepare database for monitoring: create monitoring user, required view(s), and grant permissions (idempotent)")
  .option("--db-url <url>", "PostgreSQL connection URL (admin) to run the setup against (deprecated; pass it as positional arg)")
  .option("-h, --host <host>", "PostgreSQL host (psql-like)")
  .option("-p, --port <port>", "PostgreSQL port (psql-like)")
  .option("-U, --username <username>", "PostgreSQL user (psql-like)")
  .option("-d, --dbname <dbname>", "PostgreSQL database name (psql-like)")
  .option("--admin-password <password>", "Admin connection password (otherwise uses PGPASSWORD if set)")
  .option("--monitoring-user <name>", "Monitoring role name to create/update", DEFAULT_MONITORING_USER)
  .option("--password <password>", "Monitoring role password (overrides PGAI_MON_PASSWORD)")
  .option("--skip-optional-permissions", "Skip optional permissions (RDS/self-managed extras)", false)
  .option("--verify", "Verify that monitoring role/permissions are in place (no changes)", false)
  .option("--reset-password", "Reset monitoring role password only (no other changes)", false)
  .option("--print-sql", "Print SQL plan and exit (no changes applied)", false)
  .option("--print-password", "Print generated monitoring password (DANGEROUS in CI logs)", false)
  .addHelpText(
    "after",
    [
      "",
      "Examples:",
      "  postgresai prepare-db postgresql://admin@host:5432/dbname",
      "  postgresai prepare-db \"dbname=dbname host=host user=admin\"",
      "  postgresai prepare-db -h host -p 5432 -U admin -d dbname",
      "",
      "Admin password:",
      "  --admin-password <password>   or  PGPASSWORD=... (libpq standard)",
      "",
      "Monitoring password:",
      "  --password <password>         or  PGAI_MON_PASSWORD=...  (otherwise auto-generated)",
      "  If auto-generated, it is printed only on TTY by default.",
      "  To print it in non-interactive mode: --print-password",
      "",
      "SSL connection (sslmode=prefer behavior):",
      "  Tries SSL first, falls back to non-SSL if server doesn't support it.",
      "  To force SSL: PGSSLMODE=require or ?sslmode=require in URL",
      "  To disable SSL: PGSSLMODE=disable or ?sslmode=disable in URL",
      "",
      "Environment variables (libpq standard):",
      "  PGHOST, PGPORT, PGUSER, PGDATABASE  — connection defaults",
      "  PGPASSWORD                          — admin password",
      "  PGSSLMODE                           — SSL mode (disable, require, verify-full)",
      "  PGAI_MON_PASSWORD                   — monitoring password",
      "",
      "Inspect SQL without applying changes:",
      "  postgresai prepare-db <conn> --print-sql",
      "",
      "Verify setup (no changes):",
      "  postgresai prepare-db <conn> --verify",
      "",
      "Reset monitoring password only:",
      "  postgresai prepare-db <conn> --reset-password --password '...'",
      "",
      "Offline SQL plan (no DB connection):",
      "  postgresai prepare-db --print-sql",
    ].join("\n")
  )
  .action(async (conn: string | undefined, opts: {
    dbUrl?: string;
    host?: string;
    port?: string;
    username?: string;
    dbname?: string;
    adminPassword?: string;
    monitoringUser: string;
    password?: string;
    skipOptionalPermissions?: boolean;
    verify?: boolean;
    resetPassword?: boolean;
    printSql?: boolean;
    printPassword?: boolean;
  }, cmd: Command) => {
    if (opts.verify && opts.resetPassword) {
      console.error("✗ Provide only one of --verify or --reset-password");
      process.exitCode = 1;
      return;
    }
    if (opts.verify && opts.printSql) {
      console.error("✗ --verify cannot be combined with --print-sql");
      process.exitCode = 1;
      return;
    }

    const shouldPrintSql = !!opts.printSql;
    const redactPasswords = (sql: string): string => redactPasswordsInSql(sql);

    // Offline mode: allow printing SQL without providing/using an admin connection.
    // Useful for audits/reviews; caller can provide -d/PGDATABASE.
    if (!conn && !opts.dbUrl && !opts.host && !opts.port && !opts.username && !opts.adminPassword) {
      if (shouldPrintSql) {
        const database = (opts.dbname ?? process.env.PGDATABASE ?? "postgres").trim();
        const includeOptionalPermissions = !opts.skipOptionalPermissions;

        // Use explicit password/env if provided; otherwise use a placeholder.
        // Printed SQL always redacts secrets.
        const monPassword =
          (opts.password ?? process.env.PGAI_MON_PASSWORD ?? "<redacted>").toString();

        const plan = await buildInitPlan({
          database,
          monitoringUser: opts.monitoringUser,
          monitoringPassword: monPassword,
          includeOptionalPermissions,
        });

        console.log("\n--- SQL plan (offline; not connected) ---");
        console.log(`-- database: ${database}`);
        console.log(`-- monitoring user: ${opts.monitoringUser}`);
        console.log(`-- optional permissions: ${includeOptionalPermissions ? "enabled" : "skipped"}`);
        for (const step of plan.steps) {
          console.log(`\n-- ${step.name}${step.optional ? " (optional)" : ""}`);
          console.log(redactPasswords(step.sql));
        }
        console.log("\n--- end SQL plan ---\n");
        console.log("Note: passwords are redacted in the printed SQL output.");
        return;
      }
    }

    let adminConn;
    try {
      adminConn = resolveAdminConnection({
        conn,
        dbUrlFlag: opts.dbUrl,
        // Allow libpq standard env vars as implicit defaults (common UX).
        host: opts.host ?? process.env.PGHOST,
        port: opts.port ?? process.env.PGPORT,
        username: opts.username ?? process.env.PGUSER,
        dbname: opts.dbname ?? process.env.PGDATABASE,
        adminPassword: opts.adminPassword,
        envPassword: process.env.PGPASSWORD,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`Error: prepare-db: ${msg}`);
      // When connection details are missing, show full init help (options + examples).
      if (typeof msg === "string" && msg.startsWith("Connection is required.")) {
        console.error("");
        cmd.outputHelp({ error: true });
      }
      process.exitCode = 1;
      return;
    }

    const includeOptionalPermissions = !opts.skipOptionalPermissions;

    console.log(`Connecting to: ${adminConn.display}`);
    console.log(`Monitoring user: ${opts.monitoringUser}`);
    console.log(`Optional permissions: ${includeOptionalPermissions ? "enabled" : "skipped"}`);

    // Use native pg client instead of requiring psql to be installed
    let client: Client | undefined;
    try {
      const connResult = await connectWithSslFallback(Client, adminConn);
      client = connResult.client;

      const dbRes = await client.query("select current_database() as db");
      const database = dbRes.rows?.[0]?.db;
      if (typeof database !== "string" || !database) {
        throw new Error("Failed to resolve current database name");
      }

      if (opts.verify) {
        const v = await verifyInitSetup({
          client,
          database,
          monitoringUser: opts.monitoringUser,
          includeOptionalPermissions,
        });
        if (v.ok) {
          console.log("✓ prepare-db verify: OK");
          if (v.missingOptional.length > 0) {
            console.log("⚠ Optional items missing:");
            for (const m of v.missingOptional) console.log(`- ${m}`);
          }
          return;
        }
        console.error("✗ prepare-db verify failed: missing required items");
        for (const m of v.missingRequired) console.error(`- ${m}`);
        if (v.missingOptional.length > 0) {
          console.error("Optional items missing:");
          for (const m of v.missingOptional) console.error(`- ${m}`);
        }
        process.exitCode = 1;
        return;
      }

      let monPassword: string;
      try {
        const resolved = await resolveMonitoringPassword({
          passwordFlag: opts.password,
          passwordEnv: process.env.PGAI_MON_PASSWORD,
          monitoringUser: opts.monitoringUser,
        });
        monPassword = resolved.password;
        if (resolved.generated) {
          const canPrint = process.stdout.isTTY || !!opts.printPassword;
          if (canPrint) {
            // Print secrets to stderr to reduce the chance they end up in piped stdout logs.
            const shellSafe = monPassword.replace(/'/g, "'\\''");
            console.error("");
            console.error(`Generated monitoring password for ${opts.monitoringUser} (copy/paste):`);
            // Quote for shell copy/paste safety.
            console.error(`PGAI_MON_PASSWORD='${shellSafe}'`);
            console.error("");
            console.log("Store it securely (or rerun with --password / PGAI_MON_PASSWORD to set your own).");
          } else {
            console.error(
              [
                `✗ Monitoring password was auto-generated for ${opts.monitoringUser} but not printed in non-interactive mode.`,
                "",
                "Provide it explicitly:",
                "  --password <password>   or   PGAI_MON_PASSWORD=...",
                "",
                "Or (NOT recommended) print the generated password:",
                "  --print-password",
              ].join("\n")
            );
            process.exitCode = 1;
            return;
          }
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`✗ ${msg}`);
        process.exitCode = 1;
        return;
      }

      const plan = await buildInitPlan({
        database,
        monitoringUser: opts.monitoringUser,
        monitoringPassword: monPassword,
        includeOptionalPermissions,
      });

      const effectivePlan = opts.resetPassword
        ? { ...plan, steps: plan.steps.filter((s) => s.name === "01.role") }
        : plan;

      if (shouldPrintSql) {
        console.log("\n--- SQL plan ---");
        for (const step of effectivePlan.steps) {
          console.log(`\n-- ${step.name}${step.optional ? " (optional)" : ""}`);
          console.log(redactPasswords(step.sql));
        }
        console.log("\n--- end SQL plan ---\n");
              console.log("Note: passwords are redacted in the printed SQL output.");
        return;
      }

      const { applied, skippedOptional } = await applyInitPlan({ client, plan: effectivePlan });

      console.log(opts.resetPassword ? "✓ prepare-db password reset completed" : "✓ prepare-db completed");
      if (skippedOptional.length > 0) {
        console.log("⚠ Some optional steps were skipped (not supported or insufficient privileges):");
        for (const s of skippedOptional) console.log(`- ${s}`);
      }
      // Keep output compact but still useful
      if (process.stdout.isTTY) {
        console.log(`Applied ${applied.length} steps`);
      }
    } catch (error) {
      const errAny = error as any;
      let message = "";
      if (error instanceof Error && error.message) {
        message = error.message;
      } else if (errAny && typeof errAny === "object" && typeof errAny.message === "string" && errAny.message) {
        message = errAny.message;
      } else {
        message = String(error);
      }
      if (!message || message === "[object Object]") {
        message = "Unknown error";
      }
      console.error(`Error: prepare-db: ${message}`);
      // If this was a plan step failure, surface the step name explicitly to help users diagnose quickly.
      const stepMatch =
        typeof message === "string" ? message.match(/Failed at step "([^"]+)":/i) : null;
      const failedStep = stepMatch?.[1];
      if (failedStep) {
        console.error(`  Step: ${failedStep}`);
      }
      if (errAny && typeof errAny === "object") {
        if (typeof errAny.code === "string" && errAny.code) {
          console.error(`  Code: ${errAny.code}`);
        }
        if (typeof errAny.detail === "string" && errAny.detail) {
          console.error(`  Detail: ${errAny.detail}`);
        }
        if (typeof errAny.hint === "string" && errAny.hint) {
          console.error(`  Hint: ${errAny.hint}`);
        }
      }
      if (errAny && typeof errAny === "object" && typeof errAny.code === "string") {
        if (errAny.code === "42501") {
          if (failedStep === "01.role") {
            console.error("  Context: role creation/update requires CREATEROLE or superuser");
          } else if (failedStep === "02.permissions") {
            console.error("  Context: grants/view/search_path require sufficient GRANT/DDL privileges");
          }
          console.error("  Fix: connect as a superuser (or a role with CREATEROLE and sufficient GRANT privileges)");
          console.error("  Fix: on managed Postgres, use the provider's admin/master user");
          console.error("  Tip: run with --print-sql to review the exact SQL plan");
        }
        if (errAny.code === "ECONNREFUSED") {
          console.error("  Hint: check host/port and ensure Postgres is reachable from this machine");
        }
        if (errAny.code === "ENOTFOUND") {
          console.error("  Hint: DNS resolution failed; double-check the host name");
        }
        if (errAny.code === "ETIMEDOUT") {
          console.error("  Hint: connection timed out; check network/firewall rules");
        }
      }
      process.exitCode = 1;
    } finally {
      if (client) {
        try {
          await client.end();
        } catch {
          // ignore
        }
      }
    }
  });

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
  const startDir = process.cwd();
  let currentDir = startDir;

  while (true) {
    const composeFile = path.resolve(currentDir, "docker-compose.yml");
    if (fs.existsSync(composeFile)) {
      const instancesFile = path.resolve(currentDir, "instances.yml");
      return { fs, path, projectDir: currentDir, composeFile, instancesFile };
    }

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) break;
    currentDir = parentDir;
  }

  throw new Error(
    `docker-compose.yml not found. Run monitoring commands from the PostgresAI project directory or one of its subdirectories (starting search from ${startDir}).`
  );
}

async function resolveOrInitPaths(): Promise<PathResolution> {
  try {
    return resolvePaths();
  } catch {
    return ensureDefaultMonitoringProject();
  }
}

/**
 * Check if Docker daemon is running
 */
function isDockerRunning(): boolean {
  try {
    const result = spawnSync("docker", ["info"], { stdio: "pipe" });
    return result.status === 0;
  } catch {
    return false;
  }
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
 * Check if monitoring containers are already running
 */
function checkRunningContainers(): { running: boolean; containers: string[] } {
  try {
    const result = spawnSync(
      "docker",
      ["ps", "--filter", "name=grafana-with-datasources", "--filter", "name=pgwatch", "--format", "{{.Names}}"],
      { stdio: "pipe", encoding: "utf8" }
    );

    if (result.status === 0 && result.stdout) {
      const containers = result.stdout.trim().split("\n").filter(Boolean);
      return { running: containers.length > 0, containers };
    }
    return { running: false, containers: [] };
  } catch {
    return { running: false, containers: [] };
  }
}

/**
 * Run docker compose command
 */
async function runCompose(args: string[]): Promise<number> {
  let composeFile: string;
  let projectDir: string;
  try {
    ({ composeFile, projectDir } = await resolveOrInitPaths());
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exitCode = 1;
    return 1;
  }

  // Check if Docker daemon is running
  if (!isDockerRunning()) {
    console.error("Docker is not running. Please start Docker and try again");
    process.exitCode = 1;
    return 1;
  }

  const cmd = getComposeCmd();
  if (!cmd) {
    console.error("docker compose not found (need docker-compose or docker compose)");
    process.exitCode = 1;
    return 1;
  }

  // Read Grafana password from .pgwatch-config and pass to Docker Compose
  const env = { ...process.env };
  const cfgPath = path.resolve(projectDir, ".pgwatch-config");
  if (fs.existsSync(cfgPath)) {
    try {
      const stats = fs.statSync(cfgPath);
      if (!stats.isDirectory()) {
        const content = fs.readFileSync(cfgPath, "utf8");
        const match = content.match(/^grafana_password=([^\r\n]+)/m);
        if (match) {
          env.GF_SECURITY_ADMIN_PASSWORD = match[1].trim();
        }
      }
    } catch (err) {
      // If we can't read the config, continue without setting the password
    }
  }

  return new Promise<number>((resolve) => {
    const child = spawn(cmd[0], [...cmd.slice(1), "-f", composeFile, ...args], {
      stdio: "inherit",
      env: env,
      cwd: projectDir
    });
    child.on("close", (code) => resolve(code || 0));
  });
}

program.command("help", { isDefault: true }).description("show help").action(() => {
  program.outputHelp();
});

// Monitoring services management
const mon = program.command("mon").description("monitoring services management");

mon
  .command("local-install")
  .description("install local monitoring stack (generate config, start services)")
  .option("--demo", "demo mode with sample database", false)
  .option("--api-key <key>", "Postgres AI API key for automated report uploads")
  .option("--db-url <url>", "PostgreSQL connection URL to monitor")
  .option("--tag <tag>", "Docker image tag to use (e.g., 0.14.0, 0.14.0-dev.33)")
  .option("-y, --yes", "accept all defaults and skip interactive prompts", false)
  .action(async (opts: { demo: boolean; apiKey?: string; dbUrl?: string; tag?: string; yes: boolean }) => {
    console.log("\n=================================");
    console.log("  PostgresAI monitoring local install");
    console.log("=================================\n");
    console.log("This will install, configure, and start the monitoring system\n");

    // Ensure we have a project directory with docker-compose.yml even if running from elsewhere
    const { projectDir } = await resolveOrInitPaths();
    console.log(`Project directory: ${projectDir}\n`);

    // Update .env with custom tag if provided
    const envFile = path.resolve(projectDir, ".env");
    const imageTag = opts.tag || pkg.version;

    // Build .env content
    const envLines: string[] = [`PGAI_TAG=${imageTag}`];
    // Preserve GF_SECURITY_ADMIN_PASSWORD if it exists
    if (fs.existsSync(envFile)) {
      const existingEnv = fs.readFileSync(envFile, "utf8");
      const pwdMatch = existingEnv.match(/^GF_SECURITY_ADMIN_PASSWORD=(.+)$/m);
      if (pwdMatch) {
        envLines.push(`GF_SECURITY_ADMIN_PASSWORD=${pwdMatch[1]}`);
      }
    }
    fs.writeFileSync(envFile, envLines.join("\n") + "\n", { encoding: "utf8", mode: 0o600 });

    if (opts.tag) {
      console.log(`Using image tag: ${imageTag}\n`);
    }

    // Validate conflicting options
    if (opts.demo && opts.dbUrl) {
      console.log("⚠ Both --demo and --db-url provided. Demo mode includes its own database.");
      console.log("⚠ The --db-url will be ignored in demo mode.\n");
      opts.dbUrl = undefined;
    }

    if (opts.demo && opts.apiKey) {
      console.error("✗ Cannot use --api-key with --demo mode");
      console.error("✗ Demo mode is for testing only and does not support API key integration");
      console.error("\nUse demo mode without API key: postgres-ai mon local-install --demo");
      console.error("Or use production mode with API key: postgres-ai mon local-install --api-key=your_key");
      process.exitCode = 1;
      return;
    }

    // Check if containers are already running
    const { running, containers } = checkRunningContainers();
    if (running) {
      console.log(`⚠ Monitoring services are already running: ${containers.join(", ")}`);
      console.log("Use 'postgres-ai mon restart' to restart them\n");
      return;
    }

    // Step 1: API key configuration (only in production mode)
    if (!opts.demo) {
      console.log("Step 1: Postgres AI API Configuration (Optional)");
      console.log("An API key enables automatic upload of PostgreSQL reports to Postgres AI\n");

      if (opts.apiKey) {
        console.log("Using API key provided via --api-key parameter");
        config.writeConfig({ apiKey: opts.apiKey });
        // Keep reporter compatibility (docker-compose mounts .pgwatch-config)
        fs.writeFileSync(path.resolve(projectDir, ".pgwatch-config"), `api_key=${opts.apiKey}\n`, {
          encoding: "utf8",
          mode: 0o600
        });
        console.log("✓ API key saved\n");
      } else if (opts.yes) {
        // Auto-yes mode without API key - skip API key setup
        console.log("Auto-yes mode: no API key provided, skipping API key setup");
        console.log("⚠ Reports will be generated locally only");
        console.log("You can add an API key later with: postgres-ai add-key <api_key>\n");
      } else {
        const answer = await question("Do you have a Postgres AI API key? (Y/n): ");
        const proceedWithApiKey = !answer || answer.toLowerCase() === "y";

        if (proceedWithApiKey) {
          while (true) {
            const inputApiKey = await question("Enter your Postgres AI API key: ");
            const trimmedKey = inputApiKey.trim();

            if (trimmedKey) {
              config.writeConfig({ apiKey: trimmedKey });
              // Keep reporter compatibility (docker-compose mounts .pgwatch-config)
              fs.writeFileSync(path.resolve(projectDir, ".pgwatch-config"), `api_key=${trimmedKey}\n`, {
                encoding: "utf8",
                mode: 0o600
              });
              console.log("✓ API key saved\n");
              break;
            }

            console.log("⚠ API key cannot be empty");
            const retry = await question("Try again or skip API key setup, retry? (Y/n): ");
            if (retry.toLowerCase() === "n") {
              console.log("⚠ Skipping API key setup - reports will be generated locally only");
              console.log("You can add an API key later with: postgres-ai add-key <api_key>\n");
              break;
            }
          }
        } else {
          console.log("⚠ Skipping API key setup - reports will be generated locally only");
          console.log("You can add an API key later with: postgres-ai add-key <api_key>\n");
        }
      }
    } else {
      console.log("Step 1: Demo mode - API key configuration skipped");
      console.log("Demo mode is for testing only and does not support API key integration\n");
    }

    // Step 2: Add PostgreSQL instance (if not demo mode)
    if (!opts.demo) {
      console.log("Step 2: Add PostgreSQL Instance to Monitor\n");

      // Clear instances.yml in production mode (start fresh)
      const { instancesFile: instancesPath, projectDir } = await resolveOrInitPaths();
      const emptyInstancesContent = "# PostgreSQL instances to monitor\n# Add your instances using: postgres-ai mon targets add\n\n";
      fs.writeFileSync(instancesPath, emptyInstancesContent, "utf8");
      console.log(`Instances file: ${instancesPath}`);
      console.log(`Project directory: ${projectDir}\n`);

      if (opts.dbUrl) {
        console.log("Using database URL provided via --db-url parameter");
        console.log(`Adding PostgreSQL instance from: ${opts.dbUrl}\n`);

        const match = opts.dbUrl.match(/^postgresql:\/\/[^@]+@([^:/]+)/);
        const autoInstanceName = match ? match[1] : "db-instance";

        const connStr = opts.dbUrl;
        const m = connStr.match(/^postgresql:\/\/([^:]+):([^@]+)@([^:\/]+)(?::(\d+))?\/(.+)$/);

        if (!m) {
          console.error("✗ Invalid connection string format");
          process.exitCode = 1;
          return;
        }

        const host = m[3];
        const db = m[5];
        const instanceName = `${host}-${db}`.replace(/[^a-zA-Z0-9-]/g, "-");

        const body = `- name: ${instanceName}\n  conn_str: ${connStr}\n  preset_metrics: full\n  custom_metrics:\n  is_enabled: true\n  group: default\n  custom_tags:\n    env: production\n    cluster: default\n    node_name: ${instanceName}\n    sink_type: ~sink_type~\n`;
        fs.appendFileSync(instancesPath, body, "utf8");
        console.log(`✓ Monitoring target '${instanceName}' added\n`);

        // Test connection
        console.log("Testing connection to the added instance...");
        try {
          const client = new Client({ connectionString: connStr });
          await client.connect();
          const result = await client.query("select version();");
          console.log("✓ Connection successful");
          console.log(`${result.rows[0].version}\n`);
          await client.end();
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.error(`✗ Connection failed: ${message}\n`);
        }
      } else if (opts.yes) {
        // Auto-yes mode without database URL - skip database setup
        console.log("Auto-yes mode: no database URL provided, skipping database setup");
        console.log("⚠ No PostgreSQL instance added");
        console.log("You can add one later with: postgres-ai mon targets add\n");
      } else {
        console.log("You need to add at least one PostgreSQL instance to monitor");
        const answer = await question("Do you want to add a PostgreSQL instance now? (Y/n): ");
        const proceedWithInstance = !answer || answer.toLowerCase() === "y";

        if (proceedWithInstance) {
          console.log("\nYou can provide either:");
          console.log("  1. A full connection string: postgresql://user:pass@host:port/database");
          console.log("  2. Press Enter to skip for now\n");

          const connStr = await question("Enter connection string (or press Enter to skip): ");

          if (connStr.trim()) {
            const m = connStr.match(/^postgresql:\/\/([^:]+):([^@]+)@([^:\/]+)(?::(\d+))?\/(.+)$/);
            if (!m) {
              console.error("✗ Invalid connection string format");
              console.log("⚠ Continuing without adding instance\n");
            } else {
              const host = m[3];
              const db = m[5];
              const instanceName = `${host}-${db}`.replace(/[^a-zA-Z0-9-]/g, "-");

              const body = `- name: ${instanceName}\n  conn_str: ${connStr}\n  preset_metrics: full\n  custom_metrics:\n  is_enabled: true\n  group: default\n  custom_tags:\n    env: production\n    cluster: default\n    node_name: ${instanceName}\n    sink_type: ~sink_type~\n`;
              fs.appendFileSync(instancesPath, body, "utf8");
              console.log(`✓ Monitoring target '${instanceName}' added\n`);

              // Test connection
              console.log("Testing connection to the added instance...");
              try {
                const client = new Client({ connectionString: connStr });
                await client.connect();
                const result = await client.query("select version();");
                console.log("✓ Connection successful");
                console.log(`${result.rows[0].version}\n`);
                await client.end();
              } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                console.error(`✗ Connection failed: ${message}\n`);
              }
            }
          } else {
            console.log("⚠ No PostgreSQL instance added - you can add one later with: postgres-ai mon targets add\n");
          }
        } else {
          console.log("⚠ No PostgreSQL instance added - you can add one later with: postgres-ai mon targets add\n");
        }
      }
    } else {
      console.log("Step 2: Demo mode enabled - using included demo PostgreSQL database\n");
    }

    // Step 3: Update configuration
    console.log(opts.demo ? "Step 3: Updating configuration..." : "Step 3: Updating configuration...");
    const code1 = await runCompose(["run", "--rm", "sources-generator"]);
    if (code1 !== 0) {
      process.exitCode = code1;
      return;
    }
    console.log("✓ Configuration updated\n");

    // Step 4: Ensure Grafana password is configured
    console.log(opts.demo ? "Step 4: Configuring Grafana security..." : "Step 4: Configuring Grafana security...");
    const cfgPath = path.resolve(projectDir, ".pgwatch-config");
    let grafanaPassword = "";

    try {
      if (fs.existsSync(cfgPath)) {
        const stats = fs.statSync(cfgPath);
        if (!stats.isDirectory()) {
          const content = fs.readFileSync(cfgPath, "utf8");
          const match = content.match(/^grafana_password=([^\r\n]+)/m);
          if (match) {
            grafanaPassword = match[1].trim();
          }
        }
      }

      if (!grafanaPassword) {
        console.log("Generating secure Grafana password...");
        const { stdout: password } = await execPromise("openssl rand -base64 12 | tr -d '\n'");
        grafanaPassword = password.trim();

        let configContent = "";
        if (fs.existsSync(cfgPath)) {
          const stats = fs.statSync(cfgPath);
          if (!stats.isDirectory()) {
            configContent = fs.readFileSync(cfgPath, "utf8");
          }
        }

        const lines = configContent.split(/\r?\n/).filter((l) => !/^grafana_password=/.test(l));
        lines.push(`grafana_password=${grafanaPassword}`);
        fs.writeFileSync(cfgPath, lines.filter(Boolean).join("\n") + "\n", "utf8");
      }

      console.log("✓ Grafana password configured\n");
    } catch (error) {
      console.log("⚠ Could not generate Grafana password automatically");
      console.log("Using default password: demo\n");
      grafanaPassword = "demo";
    }

    // Step 5: Start services
    console.log(opts.demo ? "Step 5: Starting monitoring services..." : "Step 5: Starting monitoring services...");
    const code2 = await runCompose(["up", "-d", "--force-recreate"]);
    if (code2 !== 0) {
      process.exitCode = code2;
      return;
    }
    console.log("✓ Services started\n");

    // Final summary
    console.log("=================================");
    console.log("  Local install completed!");
    console.log("=================================\n");

    console.log("What's running:");
    if (opts.demo) {
      console.log("  ✅ Demo PostgreSQL database (monitoring target)");
    }
    console.log("  ✅ PostgreSQL monitoring infrastructure");
    console.log("  ✅ Grafana dashboards (with secure password)");
    console.log("  ✅ Prometheus metrics storage");
    console.log("  ✅ Flask API backend");
    console.log("  ✅ Automated report generation (every 24h)");
    console.log("  ✅ Host stats monitoring (CPU, memory, disk, I/O)\n");

    if (!opts.demo) {
      console.log("Next steps:");
      console.log("  • Add more PostgreSQL instances: postgres-ai mon targets add");
      console.log("  • View configured instances: postgres-ai mon targets list");
      console.log("  • Check service health: postgres-ai mon health\n");
    } else {
      console.log("Demo mode next steps:");
      console.log("  • Explore Grafana dashboards at http://localhost:3000");
      console.log("  • Connect to demo database: postgresql://postgres:postgres@localhost:55432/target_database");
      console.log("  • Generate some load on the demo database to see metrics\n");
    }

    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log("🚀 MAIN ACCESS POINT - Start here:");
    console.log("   Grafana Dashboard: http://localhost:3000");
    console.log(`   Login: monitor / ${grafanaPassword}`);
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
  });

mon
  .command("start")
  .description("start monitoring services")
  .action(async () => {
    // Check if containers are already running
    const { running, containers } = checkRunningContainers();
    if (running) {
      console.log(`Monitoring services are already running: ${containers.join(", ")}`);
      console.log("Use 'postgres-ai mon restart' to restart them");
      return;
    }

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
    const services = [
      { name: "Grafana", container: "grafana-with-datasources" },
      { name: "Prometheus", container: "sink-prometheus" },
      { name: "PGWatch (Postgres)", container: "pgwatch-postgres" },
      { name: "PGWatch (Prometheus)", container: "pgwatch-prometheus" },
      { name: "Target DB", container: "target-db" },
      { name: "Sink Postgres", container: "sink-postgres" },
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
          const result = spawnSync("docker", ["inspect", "-f", "{{.State.Status}}", service.container], { stdio: "pipe" });
          const status = result.stdout.trim();

          if (result.status === 0 && status === 'running') {
            console.log(`✓ ${service.name}: healthy`);
          } else if (result.status === 0) {
            console.log(`✗ ${service.name}: unhealthy (status: ${status})`);
            allHealthy = false;
          } else {
            console.log(`✗ ${service.name}: unreachable`);
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
    let projectDir: string;
    let composeFile: string;
    let instancesFile: string;
    try {
      ({ projectDir, composeFile, instancesFile } = await resolveOrInitPaths());
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(message);
      process.exitCode = 1;
      return;
    }
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
    try {
      if (service) {
        // Reset specific service
        console.log(`\nThis will stop '${service}', remove its volume, and restart it.`);
        console.log("All data for this service will be lost!\n");

        const answer = await question("Continue? (y/N): ");
        if (answer.toLowerCase() !== "y") {
          console.log("Cancelled");
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
    } catch (error) {
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
    const { instancesFile: instancesPath, projectDir } = await resolveOrInitPaths();
    if (!fs.existsSync(instancesPath)) {
      console.error(`instances.yml not found in ${projectDir}`);
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

      // Filter out disabled instances (e.g., demo placeholders)
      const filtered = instances.filter((inst) => inst.name && inst.is_enabled !== false);

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
    const { instancesFile: file } = await resolveOrInitPaths();
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
    const { instancesFile: file } = await resolveOrInitPaths();
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
    const { instancesFile: instancesPath } = await resolveOrInitPaths();
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

      // Use native pg client instead of requiring psql to be installed
      const client = new Client({ connectionString: instance.conn_str });

      try {
        await client.connect();
        const result = await client.query('select version();');
        console.log(`✓ Connection successful`);
        console.log(result.rows[0].version);
      } finally {
        await client.end();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`✗ Connection failed: ${message}`);
      process.exitCode = 1;
    }
  });

// Authentication and API key management
const auth = program.command("auth").description("authentication and API key management");

auth
  .command("login", { isDefault: true })
  .description("authenticate via browser (OAuth) or store API key directly")
  .option("--set-key <key>", "store API key directly without OAuth flow")
  .option("--port <port>", "local callback server port (default: random)", parseInt)
  .option("--debug", "enable debug output")
  .action(async (opts: { setKey?: string; port?: number; debug?: boolean }) => {
    // If --set-key is provided, store it directly without OAuth
    if (opts.setKey) {
      const trimmedKey = opts.setKey.trim();
      if (!trimmedKey) {
        console.error("Error: API key cannot be empty");
        process.exitCode = 1;
        return;
      }
      
      config.writeConfig({ apiKey: trimmedKey });
      console.log(`API key saved to ${config.getConfigPath()}`);
      return;
    }

    // Otherwise, proceed with OAuth flow
    console.log("Starting authentication flow...\n");

    // Generate PKCE parameters
    const params = pkce.generatePKCEParams();

    const rootOpts = program.opts<CliOptions>();
    const cfg = config.readConfig();
    const { apiBaseUrl, uiBaseUrl } = resolveBaseUrls(rootOpts, cfg);

    if (opts.debug) {
      console.log(`Debug: Resolved API base URL: ${apiBaseUrl}`);
      console.log(`Debug: Resolved UI base URL: ${uiBaseUrl}`);
    }

    try {
      // Step 1: Start local callback server FIRST to get actual port
      console.log("Starting local callback server...");
      const requestedPort = opts.port || 0; // 0 = OS assigns available port
      const callbackServer = authServer.createCallbackServer(requestedPort, params.state, 120000); // 2 minute timeout

      // Wait for server to start and get the actual port
      const actualPort = await callbackServer.ready;
      // Use 127.0.0.1 to match the server bind address (avoids IPv6 issues on some hosts)
      const redirectUri = `http://127.0.0.1:${actualPort}/callback`;

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

      // Step 2: Initialize OAuth session on backend using fetch
      let initResponse: Response;
      try {
        initResponse = await fetch(initUrl.toString(), {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: initData,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`Failed to connect to API: ${message}`);
        callbackServer.server.stop();
        process.exit(1);
        return;
      }

      if (!initResponse.ok) {
        const data = await initResponse.text();
        console.error(`Failed to initialize auth session: ${initResponse.status}`);

        // Check if response is HTML (common for 404 pages)
        if (data.trim().startsWith("<!") || data.trim().startsWith("<html")) {
          console.error("Error: Received HTML response instead of JSON. This usually means:");
          console.error("  1. The API endpoint URL is incorrect");
          console.error("  2. The endpoint does not exist (404)");
          console.error(`\nAPI URL attempted: ${initUrl.toString()}`);
          console.error("\nPlease verify the --api-base-url parameter.");
        } else {
          console.error(data);
        }

        callbackServer.server.stop();
        process.exit(1);
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
      console.log("(Press Ctrl+C to cancel)\n");

      // Handle Ctrl+C gracefully
      const cancelHandler = () => {
        console.log("\n\nAuthentication cancelled by user.");
        callbackServer.server.stop();
        process.exit(130); // Standard exit code for SIGINT
      };
      process.on("SIGINT", cancelHandler);

      try {
        const { code } = await callbackServer.promise;

        // Remove the cancel handler after successful auth
        process.off("SIGINT", cancelHandler);

        // Step 5: Exchange code for token using fetch
        console.log("\nExchanging authorization code for API token...");
        const exchangeData = JSON.stringify({
          authorization_code: code,
          code_verifier: params.codeVerifier,
          state: params.state,
        });
        const exchangeUrl = new URL(`${apiBaseUrl}/rpc/oauth_token_exchange`);

        let exchangeResponse: Response;
        try {
          exchangeResponse = await fetch(exchangeUrl.toString(), {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: exchangeData,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.error(`Exchange request failed: ${message}`);
          process.exit(1);
          return;
        }

        const exchangeBody = await exchangeResponse.text();

        if (!exchangeResponse.ok) {
          console.error(`Failed to exchange code for token: ${exchangeResponse.status}`);

          // Check if response is HTML (common for 404 pages)
          if (exchangeBody.trim().startsWith("<!") || exchangeBody.trim().startsWith("<html")) {
            console.error("Error: Received HTML response instead of JSON. This usually means:");
            console.error("  1. The API endpoint URL is incorrect");
            console.error("  2. The endpoint does not exist (404)");
            console.error(`\nAPI URL attempted: ${exchangeUrl.toString()}`);
            console.error("\nPlease verify the --api-base-url parameter.");
          } else {
            console.error(exchangeBody);
          }

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

      } catch (err) {
        // Remove the cancel handler in error case too
        process.off("SIGINT", cancelHandler);

        const message = err instanceof Error ? err.message : String(err);

        // Provide more helpful error messages
        if (message.includes("timeout")) {
          console.error(`\nAuthentication timed out.`);
          console.error(`This usually means you closed the browser window without completing authentication.`);
          console.error(`Please try again and complete the authentication flow.`);
        } else {
          console.error(`\nAuthentication failed: ${message}`);
        }

        process.exit(1);
      }

    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`Authentication error: ${message}`);
      process.exit(1);
    }
  });

auth
  .command("show-key")
  .description("show API key (masked)")
  .action(async () => {
    const cfg = config.readConfig();
    if (!cfg.apiKey) {
      console.log("No API key configured");
      console.log(`\nTo authenticate, run: pgai auth`);
      return;
    }
    console.log(`Current API key: ${maskSecret(cfg.apiKey)}`);
    if (cfg.orgId) {
      console.log(`Organization ID: ${cfg.orgId}`);
    }
    console.log(`Config location: ${config.getConfigPath()}`);
  });

auth
  .command("remove-key")
  .description("remove API key")
  .action(async () => {
    // Check both new config and legacy config
    const newConfigPath = config.getConfigPath();
    const hasNewConfig = fs.existsSync(newConfigPath);
    let legacyPath: string;
    try {
      const { projectDir } = await resolveOrInitPaths();
      legacyPath = path.resolve(projectDir, ".pgwatch-config");
    } catch {
      legacyPath = path.resolve(process.cwd(), ".pgwatch-config");
    }
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
    const { projectDir } = await resolveOrInitPaths();
    const cfgPath = path.resolve(projectDir, ".pgwatch-config");

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
      console.log("\nReset Grafana to apply new password:");
      console.log("  postgres-ai mon reset grafana");
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
    const { projectDir } = await resolveOrInitPaths();
    const cfgPath = path.resolve(projectDir, ".pgwatch-config");
    if (!fs.existsSync(cfgPath)) {
      console.error("Configuration file not found. Run 'postgres-ai mon local-install' first.");
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

/**
 * Interpret escape sequences in a string (e.g., \n -> newline)
 * Note: In regex, to match literal backslash-n, we need \\n in the pattern
 * which requires \\\\n in the JavaScript string literal
 */
function interpretEscapes(str: string): string {
  // First handle double backslashes by temporarily replacing them
  // Then handle other escapes, then restore double backslashes as single
  return str
    .replace(/\\\\/g, '\x00') // Temporarily mark double backslashes
    .replace(/\\n/g, '\n') // Match literal backslash-n (\\\\n in JS string -> \\n in regex -> matches \n)
    .replace(/\\t/g, '\t')
    .replace(/\\r/g, '\r')
    .replace(/\\"/g, '"')
    .replace(/\\'/g, "'")
    .replace(/\x00/g, '\\'); // Restore double backslashes as single
}

// Issues management
const issues = program.command("issues").description("issues management");

issues
  .command("list")
  .description("list issues")
  .option("--debug", "enable debug output")
  .option("--json", "output raw JSON")
  .action(async (opts: { debug?: boolean; json?: boolean }) => {
    try {
      const rootOpts = program.opts<CliOptions>();
      const cfg = config.readConfig();
      const { apiKey } = getConfig(rootOpts);
      if (!apiKey) {
        console.error("API key is required. Run 'pgai auth' first or set --api-key.");
        process.exitCode = 1;
        return;
      }

      const { apiBaseUrl } = resolveBaseUrls(rootOpts, cfg);

      const result = await fetchIssues({ apiKey, apiBaseUrl, debug: !!opts.debug });
      const trimmed = Array.isArray(result)
        ? (result as any[]).map((r) => ({
            id: (r as any).id,
            title: (r as any).title,
            status: (r as any).status,
            created_at: (r as any).created_at,
          }))
        : result;
      printResult(trimmed, opts.json);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(message);
      process.exitCode = 1;
    }
  });

issues
  .command("view <issueId>")
  .description("view issue details and comments")
  .option("--debug", "enable debug output")
  .option("--json", "output raw JSON")
  .action(async (issueId: string, opts: { debug?: boolean; json?: boolean }) => {
    try {
      const rootOpts = program.opts<CliOptions>();
      const cfg = config.readConfig();
      const { apiKey } = getConfig(rootOpts);
      if (!apiKey) {
        console.error("API key is required. Run 'pgai auth' first or set --api-key.");
        process.exitCode = 1;
        return;
      }

      const { apiBaseUrl } = resolveBaseUrls(rootOpts, cfg);

      const issue = await fetchIssue({ apiKey, apiBaseUrl, issueId, debug: !!opts.debug });
      if (!issue) {
        console.error("Issue not found");
        process.exitCode = 1;
        return;
      }

      const comments = await fetchIssueComments({ apiKey, apiBaseUrl, issueId, debug: !!opts.debug });
      const combined = { issue, comments };
      printResult(combined, opts.json);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(message);
      process.exitCode = 1;
    }
  });

issues
  .command("post_comment <issueId> <content>")
  .description("post a new comment to an issue")
  .option("--parent <uuid>", "parent comment id")
  .option("--debug", "enable debug output")
  .option("--json", "output raw JSON")
  .action(async (issueId: string, content: string, opts: { parent?: string; debug?: boolean; json?: boolean }) => {
    try {
      // Interpret escape sequences in content (e.g., \n -> newline)
      if (opts.debug) {
        // eslint-disable-next-line no-console
        console.log(`Debug: Original content: ${JSON.stringify(content)}`);
      }
      content = interpretEscapes(content);
      if (opts.debug) {
        // eslint-disable-next-line no-console
        console.log(`Debug: Interpreted content: ${JSON.stringify(content)}`);
      }

      const rootOpts = program.opts<CliOptions>();
      const cfg = config.readConfig();
      const { apiKey } = getConfig(rootOpts);
      if (!apiKey) {
        console.error("API key is required. Run 'pgai auth' first or set --api-key.");
        process.exitCode = 1;
        return;
      }

      const { apiBaseUrl } = resolveBaseUrls(rootOpts, cfg);

      const result = await createIssueComment({
        apiKey,
        apiBaseUrl,
        issueId,
        content,
        parentCommentId: opts.parent,
        debug: !!opts.debug,
      });
      printResult(result, opts.json);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(message);
      process.exitCode = 1;
    }
  });

// MCP server
const mcp = program.command("mcp").description("MCP server integration");

mcp
  .command("start")
  .description("start MCP stdio server")
  .option("--debug", "enable debug output")
  .action(async (opts: { debug?: boolean }) => {
    const rootOpts = program.opts<CliOptions>();
    await startMcpServer(rootOpts, { debug: !!opts.debug });
  });

mcp
  .command("install [client]")
  .description("install MCP server configuration for AI coding tool")
  .action(async (client?: string) => {
    const supportedClients = ["cursor", "claude-code", "windsurf", "codex"];

    // If no client specified, prompt user to choose
    if (!client) {
      console.log("Available AI coding tools:");
      console.log("  1. Cursor");
      console.log("  2. Claude Code");
      console.log("  3. Windsurf");
      console.log("  4. Codex");
      console.log("");

      const answer = await question("Select your AI coding tool (1-4): ");

      const choices: Record<string, string> = {
        "1": "cursor",
        "2": "claude-code",
        "3": "windsurf",
        "4": "codex"
      };

      client = choices[answer.trim()];
      if (!client) {
        console.error("Invalid selection");
        process.exitCode = 1;
        return;
      }
    }

    client = client.toLowerCase();

    if (!supportedClients.includes(client)) {
      console.error(`Unsupported client: ${client}`);
      console.error(`Supported clients: ${supportedClients.join(", ")}`);
      process.exitCode = 1;
      return;
    }

    try {
      // Get the path to the current pgai executable
      let pgaiPath: string;
      try {
        const execPath = await execPromise("which pgai");
        pgaiPath = execPath.stdout.trim();
      } catch {
        // Fallback to just "pgai" if which fails
        pgaiPath = "pgai";
      }

      // Claude Code uses its own CLI to manage MCP servers
      if (client === "claude-code") {
        console.log("Installing PostgresAI MCP server for Claude Code...");

        try {
          const { stdout, stderr } = await execPromise(
            `claude mcp add -s user postgresai ${pgaiPath} mcp start`
          );

          if (stdout) console.log(stdout);
          if (stderr) console.error(stderr);

          console.log("");
          console.log("Successfully installed PostgresAI MCP server for Claude Code");
          console.log("");
          console.log("Next steps:");
          console.log("  1. Restart Claude Code to load the new configuration");
          console.log("  2. The PostgresAI MCP server will be available as 'postgresai'");
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.error("Failed to install MCP server using Claude CLI");
          console.error(message);
          console.error("");
          console.error("Make sure the 'claude' CLI tool is installed and in your PATH");
          console.error("See: https://docs.anthropic.com/en/docs/build-with-claude/mcp");
          process.exitCode = 1;
        }
        return;
      }

      // For other clients (Cursor, Windsurf, Codex), use JSON config editing
      const homeDir = os.homedir();
      let configPath: string;
      let configDir: string;

      // Determine config file location based on client
      switch (client) {
        case "cursor":
          configPath = path.join(homeDir, ".cursor", "mcp.json");
          configDir = path.dirname(configPath);
          break;

        case "windsurf":
          configPath = path.join(homeDir, ".windsurf", "mcp.json");
          configDir = path.dirname(configPath);
          break;

        case "codex":
          configPath = path.join(homeDir, ".codex", "mcp.json");
          configDir = path.dirname(configPath);
          break;

        default:
          console.error(`Configuration not implemented for: ${client}`);
          process.exitCode = 1;
          return;
      }

      // Ensure config directory exists
      if (!fs.existsSync(configDir)) {
        fs.mkdirSync(configDir, { recursive: true });
      }

      // Read existing config or create new one
      let config: any = { mcpServers: {} };
      if (fs.existsSync(configPath)) {
        try {
          const content = fs.readFileSync(configPath, "utf8");
          config = JSON.parse(content);
          if (!config.mcpServers) {
            config.mcpServers = {};
          }
        } catch (err) {
          console.error(`Warning: Could not parse existing config, creating new one`);
        }
      }

      // Add or update PostgresAI MCP server configuration
      config.mcpServers.postgresai = {
        command: pgaiPath,
        args: ["mcp", "start"]
      };

      // Write updated config
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf8");

      console.log(`✓ PostgresAI MCP server configured for ${client}`);
      console.log(`  Config file: ${configPath}`);
      console.log("");
      console.log("Please restart your AI coding tool to activate the MCP server");

    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Failed to install MCP server: ${message}`);
      process.exitCode = 1;
    }
  });

program.parseAsync(process.argv).finally(() => {
  closeReadline();
});

