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
import { startMcpServer } from "../lib/mcp-server";
import { fetchIssues, fetchIssueComments, createIssueComment, fetchIssue } from "../lib/issues";
import { resolveBaseUrls } from "../lib/util";
import { applyInitPlan, buildInitPlan, resolveAdminConnection, resolveMonitoringPassword } from "../lib/init";

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
  .command("init [conn]")
  .description("Create a monitoring user and grant all required permissions (idempotent)")
  .option("--db-url <url>", "PostgreSQL connection URL (admin) to run the setup against (deprecated; pass it as positional arg)")
  .option("-h, --host <host>", "PostgreSQL host (psql-like)")
  .option("-p, --port <port>", "PostgreSQL port (psql-like)")
  .option("-U, --username <username>", "PostgreSQL user (psql-like)")
  .option("-d, --dbname <dbname>", "PostgreSQL database name (psql-like)")
  .option("--admin-password <password>", "Admin connection password (otherwise uses PGPASSWORD if set)")
  .option("--monitoring-user <name>", "Monitoring role name to create/update", "postgres_ai_mon")
  .option("--password <password>", "Monitoring role password (overrides PGAI_MON_PASSWORD)")
  .option("--skip-optional-permissions", "Skip optional permissions (RDS/self-managed extras)", false)
  .option("--print-sql", "Print SQL plan before applying (does not exit; use --dry-run to exit)", false)
  .option("--show-secrets", "When printing SQL, do not redact secrets (DANGEROUS)", false)
  .option("--print-password", "Print generated monitoring password (DANGEROUS in CI logs)", false)
  .option("--dry-run", "Print SQL steps and exit without applying changes", false)
  .addHelpText(
    "after",
    [
      "",
      "Examples:",
      "  postgresai init postgresql://admin@host:5432/dbname",
      "  postgresai init \"dbname=dbname host=host user=admin\"",
      "  postgresai init -h host -p 5432 -U admin -d dbname",
      "",
      "Admin password:",
      "  --admin-password <password>   or  PGPASSWORD=... (libpq standard)",
      "",
      "Monitoring password:",
      "  --password <password>         or  PGAI_MON_PASSWORD=...  (otherwise auto-generated)",
      "  If auto-generated, it is printed only on TTY by default.",
      "  To print it in non-interactive mode: --print-password",
      "",
      "Inspect SQL without applying changes:",
      "  postgresai init <conn> --dry-run",
      "",
      "Offline SQL plan (no DB connection):",
      "  postgresai init --print-sql -d dbname --password '...' --show-secrets",
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
    printSql?: boolean;
    showSecrets?: boolean;
    printPassword?: boolean;
    dryRun?: boolean;
  }) => {
    const shouldPrintSql = !!opts.printSql || !!opts.dryRun;

    // Offline mode: allow printing SQL without providing/using an admin connection.
    // Useful for audits/reviews; caller can provide -d/PGDATABASE and an explicit monitoring password.
    if (!conn && !opts.dbUrl && !opts.host && !opts.port && !opts.username && !opts.adminPassword) {
      if (shouldPrintSql) {
        const database = (opts.dbname ?? process.env.PGDATABASE ?? "postgres").trim();
        const includeOptionalPermissions = !opts.skipOptionalPermissions;

        // Use explicit password/env if provided; otherwise use a placeholder (will be redacted unless --show-secrets).
        const monPassword =
          (opts.password ?? process.env.PGAI_MON_PASSWORD ?? "CHANGE_ME").toString();

        const plan = await buildInitPlan({
          database,
          monitoringUser: opts.monitoringUser,
          monitoringPassword: monPassword,
          includeOptionalPermissions,
          roleExists: undefined,
        });

        const redact = !opts.showSecrets;
        const redactPasswords = (sql: string): string => {
          if (!redact) return sql;
          return sql.replace(/password\s+'(?:''|[^'])*'/gi, "password '<redacted>'");
        };

        console.log("\n--- SQL plan (offline; not connected) ---");
        console.log(`-- database: ${database}`);
        console.log(`-- monitoring user: ${opts.monitoringUser}`);
        console.log(`-- optional permissions: ${includeOptionalPermissions ? "enabled" : "skipped"}`);
        for (const step of plan.steps) {
          console.log(`\n-- ${step.name}${step.optional ? " (optional)" : ""}`);
          console.log(redactPasswords(step.sql));
        }
        console.log("\n--- end SQL plan ---\n");
        if (redact) {
          console.log("Note: passwords are redacted in the printed SQL (use --show-secrets to print them).");
        }
        if (opts.dryRun) {
          console.log("✓ dry-run completed (no changes were applied)");
        }
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
      console.error(`✗ ${msg}`);
      process.exitCode = 1;
      return;
    }

    const includeOptionalPermissions = !opts.skipOptionalPermissions;

    console.log(`Connecting to: ${adminConn.display}`);
    console.log(`Monitoring user: ${opts.monitoringUser}`);
    console.log(`Optional permissions: ${includeOptionalPermissions ? "enabled" : "skipped"}`);

    // Use native pg client instead of requiring psql to be installed
    const { Client } = require("pg");
    const client = new Client(adminConn.clientConfig);

    try {
      await client.connect();

      const roleRes = await client.query("select 1 from pg_catalog.pg_roles where rolname = $1", [
        opts.monitoringUser,
      ]);
      const roleExists = roleRes.rowCount > 0;

      const dbRes = await client.query("select current_database() as db");
      const database = dbRes.rows?.[0]?.db;
      if (typeof database !== "string" || !database) {
        throw new Error("Failed to resolve current database name");
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
            console.log(`Generated password for monitoring user ${opts.monitoringUser}: ${monPassword}`);
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
        roleExists,
      });

      if (shouldPrintSql) {
        const redact = !opts.showSecrets;
        const redactPasswords = (sql: string): string => {
          if (!redact) return sql;
          // Replace PASSWORD '<literal>' (handles doubled quotes inside).
          return sql.replace(/password\s+'(?:''|[^'])*'/gi, "password '<redacted>'");
        };

        console.log("\n--- SQL plan ---");
        for (const step of plan.steps) {
          console.log(`\n-- ${step.name}${step.optional ? " (optional)" : ""}`);
          console.log(redactPasswords(step.sql));
        }
        console.log("\n--- end SQL plan ---\n");
        if (redact) {
          console.log("Note: passwords are redacted in the printed SQL (use --show-secrets to print them).");
        }
      }

      if (opts.dryRun) {
        console.log("✓ dry-run completed (no changes were applied)");
        return;
      }

      const { applied, skippedOptional } = await applyInitPlan({ client, plan });

      console.log("✓ init completed");
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
      console.error(`✗ init failed: ${message}`);
      if (errAny && typeof errAny === "object") {
        if (typeof errAny.code === "string" && errAny.code) {
          console.error(`Error code: ${errAny.code}`);
        }
        if (typeof errAny.detail === "string" && errAny.detail) {
          console.error(`Detail: ${errAny.detail}`);
        }
        if (typeof errAny.hint === "string" && errAny.hint) {
          console.error(`Hint: ${errAny.hint}`);
        }
      }
      if (errAny && typeof errAny === "object" && typeof errAny.code === "string") {
        if (errAny.code === "42501") {
          console.error("Hint: connect as a superuser (or a role with CREATEROLE and sufficient GRANT privileges).");
        }
        if (errAny.code === "ECONNREFUSED") {
          console.error("Hint: check host/port and ensure Postgres is reachable from this machine.");
        }
        if (errAny.code === "ENOTFOUND") {
          console.error("Hint: DNS resolution failed; double-check the host name.");
        }
        if (errAny.code === "ETIMEDOUT") {
          console.error("Hint: connection timed out; check network/firewall rules.");
        }
      }
      process.exitCode = 1;
    } finally {
      try {
        await client.end();
      } catch {
        // ignore
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
    ({ composeFile, projectDir } = resolvePaths());
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
      env: env
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
  .command("quickstart")
  .description("complete setup (generate config, start monitoring services)")
  .option("--demo", "demo mode with sample database", false)
  .option("--api-key <key>", "Postgres AI API key for automated report uploads")
  .option("--db-url <url>", "PostgreSQL connection URL to monitor")
  .option("-y, --yes", "accept all defaults and skip interactive prompts", false)
  .action(async (opts: { demo: boolean; apiKey?: string; dbUrl?: string; yes: boolean }) => {
    console.log("\n=================================");
    console.log("  PostgresAI Monitoring Quickstart");
    console.log("=================================\n");
    console.log("This will install, configure, and start the monitoring system\n");

    // Validate conflicting options
    if (opts.demo && opts.dbUrl) {
      console.log("⚠ Both --demo and --db-url provided. Demo mode includes its own database.");
      console.log("⚠ The --db-url will be ignored in demo mode.\n");
      opts.dbUrl = undefined;
    }

    if (opts.demo && opts.apiKey) {
      console.error("✗ Cannot use --api-key with --demo mode");
      console.error("✗ Demo mode is for testing only and does not support API key integration");
      console.error("\nUse demo mode without API key: postgres-ai mon quickstart --demo");
      console.error("Or use production mode with API key: postgres-ai mon quickstart --api-key=your_key");
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
        console.log("✓ API key saved\n");
      } else if (opts.yes) {
        // Auto-yes mode without API key - skip API key setup
        console.log("Auto-yes mode: no API key provided, skipping API key setup");
        console.log("⚠ Reports will be generated locally only");
        console.log("You can add an API key later with: postgres-ai add-key <api_key>\n");
      } else {
        const rl = readline.createInterface({
          input: process.stdin,
          output: process.stdout
        });

        const question = (prompt: string): Promise<string> =>
          new Promise((resolve) => rl.question(prompt, resolve));

        try {
          const answer = await question("Do you have a Postgres AI API key? (Y/n): ");
          const proceedWithApiKey = !answer || answer.toLowerCase() === "y";

          if (proceedWithApiKey) {
            while (true) {
              const inputApiKey = await question("Enter your Postgres AI API key: ");
              const trimmedKey = inputApiKey.trim();

              if (trimmedKey) {
                config.writeConfig({ apiKey: trimmedKey });
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
        } finally {
          rl.close();
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
      const instancesPath = path.resolve(process.cwd(), "instances.yml");
      const emptyInstancesContent = "# PostgreSQL instances to monitor\n# Add your instances using: postgres-ai mon targets add\n\n";
      fs.writeFileSync(instancesPath, emptyInstancesContent, "utf8");

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
          const { Client } = require("pg");
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
        const rl = readline.createInterface({
          input: process.stdin,
          output: process.stdout
        });

        const question = (prompt: string): Promise<string> =>
          new Promise((resolve) => rl.question(prompt, resolve));

        try {
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
                  const { Client } = require("pg");
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
        } finally {
          rl.close();
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
    const cfgPath = path.resolve(process.cwd(), ".pgwatch-config");
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
    console.log("  🎉 Quickstart setup completed!");
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
          const { execSync } = require("child_process");
          const status = execSync(`docker inspect -f '{{.State.Status}}' ${service.container} 2>/dev/null`, {
            encoding: 'utf8',
            stdio: ['pipe', 'pipe', 'pipe']
          }).trim();

          if (status === 'running') {
            console.log(`✓ ${service.name}: healthy`);
          } else {
            console.log(`✗ ${service.name}: unhealthy (status: ${status})`);
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
      ({ projectDir, composeFile, instancesFile } = resolvePaths());
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

      // Use native pg client instead of requiring psql to be installed
      const { Client } = require('pg');
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

              callbackServer.server.close();
              process.exit(1);
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
              callbackServer.server.close();
              process.exit(130); // Standard exit code for SIGINT
            };
            process.on("SIGINT", cancelHandler);

            try {
              const { code } = await callbackServer.promise;

              // Remove the cancel handler after successful auth
              process.off("SIGINT", cancelHandler);

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
    const { maskSecret } = require("../lib/util");
    console.log(`Current API key: ${maskSecret(cfg.apiKey)}`);
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

      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
      });

      const answer = await new Promise<string>((resolve) => {
        rl.question("Select your AI coding tool (1-4): ", resolve);
      });
      rl.close();

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

program.parseAsync(process.argv);

