import * as readline from "readline";
import { randomBytes } from "crypto";
import { URL } from "url";
import type { ConnectionOptions as TlsConnectionOptions } from "tls";
import type { Client as PgClient } from "pg";
import * as fs from "fs";
import * as path from "path";

export const DEFAULT_MONITORING_USER = "postgres_ai_mon";

export type PgClientConfig = {
  connectionString?: string;
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  database?: string;
  ssl?: boolean | TlsConnectionOptions;
};

export type AdminConnection = {
  clientConfig: PgClientConfig;
  display: string;
};

export type InitStep = {
  name: string;
  sql: string;
  params?: unknown[];
  optional?: boolean;
};

export type InitPlan = {
  monitoringUser: string;
  database: string;
  steps: InitStep[];
};

function packageRootDirFromCompiled(): string {
  // dist/lib/init.js -> <pkg>/dist/lib ; package root is ../..
  return path.resolve(__dirname, "..", "..");
}

function sqlDir(): string {
  return path.join(packageRootDirFromCompiled(), "sql");
}

function loadSqlTemplate(filename: string): string {
  const p = path.join(sqlDir(), filename);
  return fs.readFileSync(p, "utf8");
}

function applyTemplate(sql: string, vars: Record<string, string>): string {
  return sql.replace(/\{\{([A-Z0-9_]+)\}\}/g, (_, key) => {
    const v = vars[key];
    if (v === undefined) throw new Error(`Missing SQL template var: ${key}`);
    return v;
  });
}

function quoteIdent(ident: string): string {
  // Always quote. Escape embedded quotes by doubling.
  if (ident.includes("\0")) {
    throw new Error("Identifier cannot contain null bytes");
  }
  return `"${ident.replace(/"/g, "\"\"")}"`;
}

function quoteLiteral(value: string): string {
  // Single-quote and escape embedded quotes by doubling.
  // This is used where Postgres grammar requires a literal (e.g., CREATE/ALTER ROLE PASSWORD).
  if (value.includes("\0")) {
    throw new Error("Literal cannot contain null bytes");
  }
  return `'${value.replace(/'/g, "''")}'`;
}

export function redactPasswordsInSql(sql: string): string {
  // Replace PASSWORD '<literal>' (handles doubled quotes inside).
  return sql.replace(/password\s+'(?:''|[^'])*'/gi, "password '<redacted>'");
}

export function maskConnectionString(dbUrl: string): string {
  // Hide password if present (postgresql://user:pass@host/db).
  try {
    const u = new URL(dbUrl);
    if (u.password) u.password = "*****";
    return u.toString();
  } catch {
    return dbUrl.replace(/\/\/([^:/?#]+):([^@/?#]+)@/g, "//$1:*****@");
  }
}

function isLikelyUri(value: string): boolean {
  return /^postgres(ql)?:\/\//i.test(value.trim());
}

function tokenizeConninfo(input: string): string[] {
  const s = input.trim();
  const tokens: string[] = [];
  let i = 0;

  const isSpace = (ch: string) => ch === " " || ch === "\t" || ch === "\n" || ch === "\r";

  while (i < s.length) {
    while (i < s.length && isSpace(s[i]!)) i++;
    if (i >= s.length) break;

    let tok = "";
    let inSingle = false;
    while (i < s.length) {
      const ch = s[i]!;
      if (!inSingle && isSpace(ch)) break;

      if (ch === "'" && !inSingle) {
        inSingle = true;
        i++;
        continue;
      }
      if (ch === "'" && inSingle) {
        inSingle = false;
        i++;
        continue;
      }

      if (ch === "\\" && i + 1 < s.length) {
        tok += s[i + 1]!;
        i += 2;
        continue;
      }

      tok += ch;
      i++;
    }

    tokens.push(tok);
    while (i < s.length && isSpace(s[i]!)) i++;
  }

  return tokens;
}

export function parseLibpqConninfo(input: string): PgClientConfig {
  const tokens = tokenizeConninfo(input);
  const cfg: PgClientConfig = {};

  for (const t of tokens) {
    const eq = t.indexOf("=");
    if (eq <= 0) continue;
    const key = t.slice(0, eq).trim();
    const rawVal = t.slice(eq + 1);
    const val = rawVal.trim();
    if (!key) continue;

    switch (key) {
      case "host":
        cfg.host = val;
        break;
      case "port": {
        const p = Number(val);
        if (Number.isFinite(p)) cfg.port = p;
        break;
      }
      case "user":
        cfg.user = val;
        break;
      case "password":
        cfg.password = val;
        break;
      case "dbname":
      case "database":
        cfg.database = val;
        break;
      // ignore everything else (sslmode, options, application_name, etc.)
      default:
        break;
    }
  }

  return cfg;
}

export function describePgConfig(cfg: PgClientConfig): string {
  if (cfg.connectionString) return maskConnectionString(cfg.connectionString);
  const user = cfg.user ? cfg.user : "<user>";
  const host = cfg.host ? cfg.host : "<host>";
  const port = cfg.port ? String(cfg.port) : "<port>";
  const db = cfg.database ? cfg.database : "<db>";
  // Don't include password
  return `postgresql://${user}:*****@${host}:${port}/${db}`;
}

export function resolveAdminConnection(opts: {
  conn?: string;
  dbUrlFlag?: string;
  host?: string;
  port?: string | number;
  username?: string;
  dbname?: string;
  adminPassword?: string;
  envPassword?: string;
}): AdminConnection {
  const conn = (opts.conn || "").trim();
  const dbUrlFlag = (opts.dbUrlFlag || "").trim();

  // NOTE: passwords alone (PGPASSWORD / --admin-password) do NOT constitute a connection.
  // We require at least some connection addressing (host/port/user/db) if no positional arg / --db-url is provided.
  const hasConnDetails = !!(opts.host || opts.port || opts.username || opts.dbname);

  if (conn && dbUrlFlag) {
    throw new Error("Provide either positional connection string or --db-url, not both");
  }

  if (conn || dbUrlFlag) {
    const v = conn || dbUrlFlag;
    if (isLikelyUri(v)) {
      return { clientConfig: { connectionString: v }, display: maskConnectionString(v) };
    }
    // libpq conninfo (dbname=... host=...)
    const cfg = parseLibpqConninfo(v);
    if (opts.envPassword && !cfg.password) cfg.password = opts.envPassword;
    return { clientConfig: cfg, display: describePgConfig(cfg) };
  }

  if (!hasConnDetails) {
    throw new Error(
      [
        "Connection is required.",
        "",
        "Examples:",
        "  postgresai init postgresql://admin@host:5432/dbname",
        "  postgresai init \"dbname=dbname host=host user=admin\"",
        "  postgresai init -h host -p 5432 -U admin -d dbname",
        "",
        "Admin password:",
        "  --admin-password <password>  (or set PGPASSWORD)",
      ].join("\n")
    );
  }

  const cfg: PgClientConfig = {};
  if (opts.host) cfg.host = opts.host;
  if (opts.port !== undefined && opts.port !== "") {
    const p = Number(opts.port);
    if (!Number.isFinite(p) || !Number.isInteger(p) || p <= 0 || p > 65535) {
      throw new Error(`Invalid port value: ${String(opts.port)}`);
    }
    cfg.port = p;
  }
  if (opts.username) cfg.user = opts.username;
  if (opts.dbname) cfg.database = opts.dbname;
  if (opts.adminPassword) cfg.password = opts.adminPassword;
  if (opts.envPassword && !cfg.password) cfg.password = opts.envPassword;
  return { clientConfig: cfg, display: describePgConfig(cfg) };
}

export async function promptHidden(prompt: string): Promise<string> {
  // Implement our own hidden input reader so:
  // - prompt text is visible
  // - only user input is masked
  // - we don't rely on non-public readline internals
  if (!process.stdin.isTTY) {
    throw new Error("Cannot prompt for password in non-interactive mode");
  }

  const stdin = process.stdin;
  const stdout = process.stdout as NodeJS.WriteStream;

  stdout.write(prompt);

  return await new Promise<string>((resolve, reject) => {
    let value = "";

    const cleanup = () => {
      try {
        stdin.setRawMode(false);
      } catch {
        // ignore
      }
      stdin.removeListener("keypress", onKeypress);
    };

    const onKeypress = (str: string, key: any) => {
      if (key?.ctrl && key?.name === "c") {
        stdout.write("\n");
        cleanup();
        reject(new Error("Cancelled"));
        return;
      }

      if (key?.name === "return" || key?.name === "enter") {
        stdout.write("\n");
        cleanup();
        resolve(value);
        return;
      }

      if (key?.name === "backspace") {
        if (value.length > 0) {
          value = value.slice(0, -1);
          // Erase one mask char.
          stdout.write("\b \b");
        }
        return;
      }

      // Ignore other control keys.
      if (key?.ctrl || key?.meta) return;

      if (typeof str === "string" && str.length > 0) {
        value += str;
        stdout.write("*");
      }
    };

    readline.emitKeypressEvents(stdin);
    stdin.setRawMode(true);
    stdin.on("keypress", onKeypress);
    stdin.resume();
  });
}

function generateMonitoringPassword(): string {
  // URL-safe and easy to copy/paste; 24 bytes => 32 base64url chars (no padding).
  // Note: randomBytes() throws on failure; we add a tiny sanity check for unexpected output.
  const password = randomBytes(24).toString("base64url");
  if (password.length < 30) {
    throw new Error("Password generation failed: unexpected output length");
  }
  return password;
}

export async function resolveMonitoringPassword(opts: {
  passwordFlag?: string;
  passwordEnv?: string;
  prompt?: (prompt: string) => Promise<string>;
  monitoringUser: string;
}): Promise<{ password: string; generated: boolean }> {
  const fromFlag = (opts.passwordFlag || "").trim();
  if (fromFlag) return { password: fromFlag, generated: false };

  const fromEnv = (opts.passwordEnv || "").trim();
  if (fromEnv) return { password: fromEnv, generated: false };

  // Default: auto-generate (safer than prompting; works in non-interactive mode).
  return { password: generateMonitoringPassword(), generated: true };
}

export async function buildInitPlan(params: {
  database: string;
  monitoringUser?: string;
  monitoringPassword: string;
  includeOptionalPermissions: boolean;
}): Promise<InitPlan> {
  const monitoringUser = params.monitoringUser || DEFAULT_MONITORING_USER;
  const database = params.database;

  const qRole = quoteIdent(monitoringUser);
  const qDb = quoteIdent(database);
  const qPw = quoteLiteral(params.monitoringPassword);
  const qRoleNameLit = quoteLiteral(monitoringUser);

  const steps: InitStep[] = [];

  const vars = {
    ROLE_IDENT: qRole,
    DB_IDENT: qDb,
  };

  // Role creation/update is done in one template file.
  // Always use a single DO block to avoid race conditions between "role exists?" checks and CREATE USER.
  // We:
  // - create role if missing (and handle duplicate_object in case another session created it concurrently),
  // - then ALTER ROLE to ensure the password is set to the desired value.
  const roleStmt = `do $$ begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = ${qRoleNameLit}) then
    begin
      create user ${qRole} with password ${qPw};
    exception when duplicate_object then
      null;
    end;
  end if;
  alter user ${qRole} with password ${qPw};
end $$;`;

  const roleSql = applyTemplate(loadSqlTemplate("01.role.sql"), { ...vars, ROLE_STMT: roleStmt });
  steps.push({ name: "01.role", sql: roleSql });

  steps.push({
    name: "02.permissions",
    sql: applyTemplate(loadSqlTemplate("02.permissions.sql"), vars),
  });

  if (params.includeOptionalPermissions) {
    steps.push(
      {
        name: "03.optional_rds",
        sql: applyTemplate(loadSqlTemplate("03.optional_rds.sql"), vars),
        optional: true,
      },
      {
        name: "04.optional_self_managed",
        sql: applyTemplate(loadSqlTemplate("04.optional_self_managed.sql"), vars),
        optional: true,
      }
    );
  }

  return { monitoringUser, database, steps };
}

export async function applyInitPlan(params: {
  client: PgClient;
  plan: InitPlan;
  verbose?: boolean;
}): Promise<{ applied: string[]; skippedOptional: string[] }> {
  const applied: string[] = [];
  const skippedOptional: string[] = [];

  // Apply non-optional steps in a single transaction.
  await params.client.query("begin;");
  try {
    for (const step of params.plan.steps.filter((s) => !s.optional)) {
      try {
        await params.client.query(step.sql, step.params as any);
        applied.push(step.name);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const errAny = e as any;
        const wrapped: any = new Error(`Failed at step "${step.name}": ${msg}`);
        // Preserve useful Postgres error fields so callers can provide better hints / diagnostics.
        const pgErrorFields = [
          "code",
          "detail",
          "hint",
          "position",
          "internalPosition",
          "internalQuery",
          "where",
          "schema",
          "table",
          "column",
          "dataType",
          "constraint",
          "file",
          "line",
          "routine",
        ] as const;
        if (errAny && typeof errAny === "object") {
          for (const field of pgErrorFields) {
            if (errAny[field] !== undefined) wrapped[field] = errAny[field];
          }
        }
        if (e instanceof Error && e.stack) {
          wrapped.stack = e.stack;
        }
        throw wrapped;
      }
    }
    await params.client.query("commit;");
  } catch (e) {
    // Rollback errors should never mask the original failure.
    try {
      await params.client.query("rollback;");
    } catch {
      // ignore
    }
    throw e;
  }

  // Apply optional steps outside of the transaction so a failure doesn't abort everything.
  for (const step of params.plan.steps.filter((s) => s.optional)) {
    try {
      // Run each optional step in its own mini-transaction to avoid partial application.
      await params.client.query("begin;");
      try {
        await params.client.query(step.sql, step.params as any);
        await params.client.query("commit;");
        applied.push(step.name);
      } catch {
        try {
          await params.client.query("rollback;");
        } catch {
          // ignore rollback errors
        }
        skippedOptional.push(step.name);
        // best-effort: ignore
      }
    } catch {
      // If we can't even begin/commit, treat as skipped.
      skippedOptional.push(step.name);
    }
  }

  return { applied, skippedOptional };
}

export type VerifyInitResult = {
  ok: boolean;
  missingRequired: string[];
  missingOptional: string[];
};

export async function verifyInitSetup(params: {
  client: PgClient;
  database: string;
  monitoringUser: string;
  includeOptionalPermissions: boolean;
}): Promise<VerifyInitResult> {
  // Use a repeatable-read snapshot so all checks see a consistent view.
  await params.client.query("begin isolation level repeatable read;");
  try {
    const missingRequired: string[] = [];
    const missingOptional: string[] = [];

    const role = params.monitoringUser;
    const db = params.database;

    const roleRes = await params.client.query("select 1 from pg_catalog.pg_roles where rolname = $1", [role]);
    const roleExists = (roleRes.rowCount ?? 0) > 0;
    if (!roleExists) {
      missingRequired.push(`role "${role}" does not exist`);
      // If role is missing, other checks will error or be meaningless.
      return { ok: false, missingRequired, missingOptional };
    }

    const connectRes = await params.client.query(
      "select has_database_privilege($1, $2, 'CONNECT') as ok",
      [role, db]
    );
    if (!connectRes.rows?.[0]?.ok) {
      missingRequired.push(`CONNECT on database "${db}"`);
    }

    const pgMonitorRes = await params.client.query(
      "select pg_has_role($1, 'pg_monitor', 'member') as ok",
      [role]
    );
    if (!pgMonitorRes.rows?.[0]?.ok) {
      missingRequired.push("membership in role pg_monitor");
    }

    const pgIndexRes = await params.client.query(
      "select has_table_privilege($1, 'pg_catalog.pg_index', 'SELECT') as ok",
      [role]
    );
    if (!pgIndexRes.rows?.[0]?.ok) {
      missingRequired.push("SELECT on pg_catalog.pg_index");
    }

    const viewExistsRes = await params.client.query("select to_regclass('public.pg_statistic') is not null as ok");
    if (!viewExistsRes.rows?.[0]?.ok) {
      missingRequired.push("view public.pg_statistic exists");
    } else {
      const viewPrivRes = await params.client.query(
        "select has_table_privilege($1, 'public.pg_statistic', 'SELECT') as ok",
        [role]
      );
      if (!viewPrivRes.rows?.[0]?.ok) {
        missingRequired.push("SELECT on view public.pg_statistic");
      }
    }

    const schemaUsageRes = await params.client.query(
      "select has_schema_privilege($1, 'public', 'USAGE') as ok",
      [role]
    );
    if (!schemaUsageRes.rows?.[0]?.ok) {
      missingRequired.push("USAGE on schema public");
    }

    const rolcfgRes = await params.client.query("select rolconfig from pg_catalog.pg_roles where rolname = $1", [role]);
    const rolconfig = rolcfgRes.rows?.[0]?.rolconfig;
    const spLine = Array.isArray(rolconfig) ? rolconfig.find((v: any) => String(v).startsWith("search_path=")) : undefined;
    if (typeof spLine !== "string" || !spLine) {
      missingRequired.push("role search_path is set");
    } else {
      // We accept any ordering as long as public and pg_catalog are included.
      const sp = spLine.toLowerCase();
      if (!sp.includes("public") || !sp.includes("pg_catalog")) {
        missingRequired.push("role search_path includes public and pg_catalog");
      }
    }

    if (params.includeOptionalPermissions) {
      // Optional RDS/Aurora extras
      {
        const extRes = await params.client.query("select 1 from pg_extension where extname = 'rds_tools'");
        if ((extRes.rowCount ?? 0) === 0) {
          missingOptional.push("extension rds_tools");
        } else {
          const fnRes = await params.client.query(
            "select has_function_privilege($1, 'rds_tools.pg_ls_multixactdir()', 'EXECUTE') as ok",
            [role]
          );
          if (!fnRes.rows?.[0]?.ok) {
            missingOptional.push("EXECUTE on rds_tools.pg_ls_multixactdir()");
          }
        }
      }

      // Optional self-managed extras
      const optionalFns = [
        "pg_catalog.pg_stat_file(text)",
        "pg_catalog.pg_stat_file(text, boolean)",
        "pg_catalog.pg_ls_dir(text)",
        "pg_catalog.pg_ls_dir(text, boolean, boolean)",
      ];
      for (const fn of optionalFns) {
        const fnRes = await params.client.query("select has_function_privilege($1, $2, 'EXECUTE') as ok", [role, fn]);
        if (!fnRes.rows?.[0]?.ok) {
          missingOptional.push(`EXECUTE on ${fn}`);
        }
      }
    }

    return { ok: missingRequired.length === 0, missingRequired, missingOptional };
  } finally {
    // Read-only: rollback to release snapshot; do not mask original errors.
    try {
      await params.client.query("rollback;");
    } catch {
      // ignore
    }
  }
}


