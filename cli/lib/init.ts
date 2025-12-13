import * as readline from "readline";
import { URL } from "url";
import type { Client as PgClient } from "pg";

export type PgClientConfig = {
  connectionString?: string;
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  database?: string;
  ssl?: any;
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

function quoteIdent(ident: string): string {
  // Always quote. Escape embedded quotes by doubling.
  return `"${ident.replace(/"/g, "\"\"")}"`;
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

  const hasPsqlParts =
    !!(opts.host || opts.port || opts.username || opts.dbname || opts.adminPassword || opts.envPassword);

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

  if (!hasPsqlParts) {
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
  if (opts.port !== undefined && opts.port !== "") cfg.port = Number(opts.port);
  if (opts.username) cfg.user = opts.username;
  if (opts.dbname) cfg.database = opts.dbname;
  if (opts.adminPassword) cfg.password = opts.adminPassword;
  if (opts.envPassword && !cfg.password) cfg.password = opts.envPassword;
  return { clientConfig: cfg, display: describePgConfig(cfg) };
}

export async function promptHidden(prompt: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });

  // Mask input by overriding internal write method.
  const anyRl = rl as any;
  const out = process.stdout as NodeJS.WriteStream;
  anyRl._writeToOutput = (str: string) => {
    // Keep newlines and carriage returns; mask everything else.
    if (str === "\n" || str === "\r\n") {
      out.write(str);
    } else {
      out.write("*");
    }
  };

  try {
    const answer = await new Promise<string>((resolve) => rl.question(prompt, resolve));
    // Ensure we end the masked line cleanly.
    process.stdout.write("\n");
    return answer;
  } finally {
    rl.close();
  }
}

export async function resolveMonitoringPassword(opts: {
  passwordFlag?: string;
  passwordEnv?: string;
  prompt?: (prompt: string) => Promise<string>;
  monitoringUser: string;
}): Promise<string> {
  const fromFlag = (opts.passwordFlag || "").trim();
  if (fromFlag) return fromFlag;

  const fromEnv = (opts.passwordEnv || "").trim();
  if (fromEnv) return fromEnv;

  if (!process.stdin.isTTY) {
    throw new Error(
      "Monitoring user password is required in non-interactive mode (use --password or PGAI_MON_PASSWORD)"
    );
  }

  const prompter = opts.prompt || promptHidden;
  while (true) {
    const pw = (await prompter(`Enter password for monitoring user ${opts.monitoringUser}: `)).trim();
    if (pw) return pw;
    // eslint-disable-next-line no-console
    console.error("Password cannot be empty");
  }
}

export async function buildInitPlan(params: {
  database: string;
  monitoringUser?: string;
  monitoringPassword: string;
  includeOptionalPermissions: boolean;
  roleExists?: boolean;
}): Promise<InitPlan> {
  const monitoringUser = params.monitoringUser || "postgres_ai_mon";
  const database = params.database;

  const qRole = quoteIdent(monitoringUser);
  const qDb = quoteIdent(database);

  const steps: InitStep[] = [];

  // Role creation/update is done in two alternative steps. Caller decides by checking role existence.
  if (params.roleExists === false) {
    steps.push({
      name: "create monitoring user",
      sql: `create user ${qRole} with password $1;`,
      params: [params.monitoringPassword],
    });
  } else if (params.roleExists === true) {
    steps.push({
      name: "update monitoring user password",
      sql: `alter user ${qRole} with password $1;`,
      params: [params.monitoringPassword],
    });
  } else {
    // Unknown: caller will rebuild after probing role existence.
  }

  steps.push(
    {
      name: "grant connect on database",
      sql: `grant connect on database ${qDb} to ${qRole};`,
    },
    {
      name: "grant pg_monitor",
      sql: `grant pg_monitor to ${qRole};`,
    },
    {
      name: "grant select on pg_index",
      sql: `grant select on pg_catalog.pg_index to ${qRole};`,
    },
    {
      name: "create or replace public.pg_statistic view",
      sql: `create or replace view public.pg_statistic as
select
    n.nspname as schemaname,
    c.relname as tablename,
    a.attname,
    s.stanullfrac as null_frac,
    s.stawidth as avg_width,
    false as inherited
from pg_catalog.pg_statistic s
join pg_catalog.pg_class c on c.oid = s.starelid
join pg_catalog.pg_namespace n on n.oid = c.relnamespace
join pg_catalog.pg_attribute a on a.attrelid = s.starelid and a.attnum = s.staattnum
where a.attnum > 0 and not a.attisdropped;`,
    },
    {
      name: "grant select on public.pg_statistic",
      sql: `grant select on public.pg_statistic to ${qRole};`,
    },
    {
      name: "ensure access to public schema (for hardened clusters)",
      sql: `grant usage on schema public to ${qRole};`,
    },
    {
      name: "set monitoring user search_path",
      sql: `alter user ${qRole} set search_path = "$user", public, pg_catalog;`,
    }
  );

  if (params.includeOptionalPermissions) {
    steps.push(
      {
        name: "create rds_tools extension (optional)",
        sql: "create extension if not exists rds_tools;",
        optional: true,
      },
      {
        name: "grant rds_tools.pg_ls_multixactdir() (optional)",
        sql: `grant execute on function rds_tools.pg_ls_multixactdir() to ${qRole};`,
        optional: true,
      },
      {
        name: "grant pg_stat_file(text) (optional)",
        sql: `grant execute on function pg_catalog.pg_stat_file(text) to ${qRole};`,
        optional: true,
      },
      {
        name: "grant pg_stat_file(text, boolean) (optional)",
        sql: `grant execute on function pg_catalog.pg_stat_file(text, boolean) to ${qRole};`,
        optional: true,
      },
      {
        name: "grant pg_ls_dir(text) (optional)",
        sql: `grant execute on function pg_catalog.pg_ls_dir(text) to ${qRole};`,
        optional: true,
      },
      {
        name: "grant pg_ls_dir(text, boolean, boolean) (optional)",
        sql: `grant execute on function pg_catalog.pg_ls_dir(text, boolean, boolean) to ${qRole};`,
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
        throw new Error(`Failed at step "${step.name}": ${msg}`);
      }
    }
    await params.client.query("commit;");
  } catch (e) {
    await params.client.query("rollback;");
    throw e;
  }

  // Apply optional steps outside of the transaction so a failure doesn't abort everything.
  for (const step of params.plan.steps.filter((s) => s.optional)) {
    try {
      await params.client.query(step.sql, step.params as any);
      applied.push(step.name);
    } catch {
      skippedOptional.push(step.name);
      // best-effort: ignore
    }
  }

  return { applied, skippedOptional };
}


