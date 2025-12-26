const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const { spawn, spawnSync } = require("node:child_process");

function sqlLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function findOnPath(cmd) {
  const which = spawnSync("sh", ["-lc", `command -v ${cmd}`], { encoding: "utf8" });
  if (which.status === 0) return String(which.stdout || "").trim();
  return null;
}

function findPgBin(cmd) {
  const p = findOnPath(cmd);
  if (p) return p;

  // Debian/Ubuntu (GitLab CI node:*-bullseye images): binaries usually live here.
  // We avoid filesystem globbing in JS and just ask the shell.
  const probe = spawnSync(
    "sh",
    [
      "-lc",
      `ls -1 /usr/lib/postgresql/*/bin/${cmd} 2>/dev/null | head -n 1 || true`,
    ],
    { encoding: "utf8" }
  );
  const out = String(probe.stdout || "").trim();
  if (out) return out;

  return null;
}

function havePostgresBinaries() {
  return !!(findPgBin("initdb") && findPgBin("postgres"));
}

async function getFreePort() {
  return await new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      srv.close((err) => {
        if (err) return reject(err);
        resolve(addr.port);
      });
    });
    srv.on("error", reject);
  });
}

async function waitFor(fn, { timeoutMs = 10000, intervalMs = 100 } = {}) {
  const start = Date.now();
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      return await fn();
    } catch (e) {
      if (Date.now() - start > timeoutMs) throw e;
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }
}

async function withTempPostgres(t) {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "postgresai-init-"));
  const dataDir = path.join(tmpRoot, "data");
  const socketDir = path.join(tmpRoot, "sock");
  fs.mkdirSync(socketDir, { recursive: true });

  const initdb = findPgBin("initdb");
  const postgresBin = findPgBin("postgres");
  assert.ok(initdb && postgresBin, "PostgreSQL binaries not found (need initdb and postgres)");

  const init = spawnSync(initdb, ["-D", dataDir, "-U", "postgres", "-A", "trust"], {
    encoding: "utf8",
  });
  assert.equal(init.status, 0, init.stderr || init.stdout);

  // Configure: local socket trust, TCP scram.
  const hbaPath = path.join(dataDir, "pg_hba.conf");
  fs.appendFileSync(
    hbaPath,
    "\n# Added by postgresai init integration tests\nlocal all all trust\nhost all all 127.0.0.1/32 scram-sha-256\nhost all all ::1/128 scram-sha-256\n",
    "utf8"
  );

  const port = await getFreePort();

  let postgresProc;
  try {
    postgresProc = spawn(
      postgresBin,
      ["-D", dataDir, "-k", socketDir, "-h", "127.0.0.1", "-p", String(port)],
      {
        stdio: ["ignore", "pipe", "pipe"],
      }
    );

    // Register cleanup immediately so failures below don't leave a running postgres and hang CI.
    t.after(async () => {
      postgresProc.kill("SIGTERM");
      try {
        await waitFor(
          async () => {
            if (postgresProc.exitCode === null) throw new Error("still running");
          },
          { timeoutMs: 5000, intervalMs: 100 }
        );
      } catch {
        postgresProc.kill("SIGKILL");
      }
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    });
  } catch (e) {
    // If anything goes wrong before cleanup is registered, ensure we don't leak a running postgres.
    try {
      if (postgresProc) postgresProc.kill("SIGKILL");
    } catch {
      // ignore
    }
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    throw e;
  }

  const { Client } = require("pg");

  const connectLocal = async (database = "postgres") => {
    // IMPORTANT: must match the port Postgres is started with; otherwise pg defaults to 5432 and the socket path won't exist.
    const c = new Client({ host: socketDir, port, user: "postgres", database });
    await c.connect();
    return c;
  };

  await waitFor(async () => {
    const c = await connectLocal();
    await c.end();
  });

  const postgresPassword = "postgrespw";
  {
    const c = await connectLocal();
    await c.query(`alter user postgres password ${sqlLiteral(postgresPassword)};`);
    await c.query("create database testdb");
    await c.end();
  }

  const adminUri = `postgresql://postgres:${postgresPassword}@127.0.0.1:${port}/testdb`;
  return { port, socketDir, adminUri, postgresPassword };
}

async function runCliInit(args, env = {}) {
  const node = process.execPath;
  const cliPath = path.resolve(__dirname, "..", "dist", "bin", "postgres-ai.js");
  const res = spawnSync(node, [cliPath, "prepare-db", ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return res;
}

test(
  "integration: prepare-db supports URI / conninfo / psql-like connection styles",
  { skip: !havePostgresBinaries() },
  async (t) => {
    const pg = await withTempPostgres(t);

    // 1) positional URI
    {
      const r = await runCliInit([pg.adminUri, "--password", "monpw", "--skip-optional-permissions"]);
      assert.equal(r.status, 0, r.stderr || r.stdout);
    }

    // 2) conninfo
    {
      const conninfo = `dbname=testdb host=127.0.0.1 port=${pg.port} user=postgres password=${pg.postgresPassword}`;
      const r = await runCliInit([conninfo, "--password", "monpw2", "--skip-optional-permissions"]);
      assert.equal(r.status, 0, r.stderr || r.stdout);
    }

    // 3) psql-like options (+ PGPASSWORD)
    {
      const r = await runCliInit(
        [
          "-h",
          "127.0.0.1",
          "-p",
          String(pg.port),
          "-U",
          "postgres",
          "-d",
          "testdb",
          "--password",
          "monpw3",
          "--skip-optional-permissions",
        ],
        { PGPASSWORD: pg.postgresPassword }
      );
      assert.equal(r.status, 0, r.stderr || r.stdout);
    }
  }
);

test(
  "integration: prepare-db requires explicit monitoring password in non-interactive mode (unless --print-password)",
  { skip: !havePostgresBinaries() },
  async (t) => {
    const pg = await withTempPostgres(t);

    // spawnSync captures stdout/stderr (non-TTY). We should not print a generated password unless explicitly requested.
    {
      const r = await runCliInit([pg.adminUri, "--skip-optional-permissions"]);
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, /not printed in non-interactive mode/i);
      assert.match(r.stderr, /--print-password/);
    }

    // With explicit opt-in, it should succeed (and will print the generated password).
    {
      const r = await runCliInit([pg.adminUri, "--print-password", "--skip-optional-permissions"]);
      assert.equal(r.status, 0, r.stderr || r.stdout);
      assert.match(r.stderr, /Generated monitoring password for postgres_ai_mon/i);
      assert.match(r.stderr, /PGAI_MON_PASSWORD=/);
    }
  }
);

test(
  "integration: prepare-db fixes slightly-off permissions idempotently",
  { skip: !havePostgresBinaries() },
  async (t) => {
    const pg = await withTempPostgres(t);
    const { Client } = require("pg");

    // Create monitoring role with wrong password, no grants.
    {
      const c = new Client({ connectionString: pg.adminUri });
      await c.connect();
      await c.query(
        "do $$ begin if not exists (select 1 from pg_roles where rolname='postgres_ai_mon') then create role postgres_ai_mon login password 'wrong'; end if; end $$;"
      );
      await c.end();
    }

    // Run init (should grant everything).
    {
      const r = await runCliInit([pg.adminUri, "--password", "correctpw", "--skip-optional-permissions"]);
      assert.equal(r.status, 0, r.stderr || r.stdout);
    }

    // Verify privileges.
    {
      const c = new Client({ connectionString: pg.adminUri });
      await c.connect();
      const dbOk = await c.query(
        "select has_database_privilege('postgres_ai_mon', current_database(), 'CONNECT') as ok"
      );
      assert.equal(dbOk.rows[0].ok, true);
      const roleOk = await c.query("select pg_has_role('postgres_ai_mon', 'pg_monitor', 'member') as ok");
      assert.equal(roleOk.rows[0].ok, true);
      const idxOk = await c.query(
        "select has_table_privilege('postgres_ai_mon', 'pg_catalog.pg_index', 'SELECT') as ok"
      );
      assert.equal(idxOk.rows[0].ok, true);
      const viewOk = await c.query(
        "select has_table_privilege('postgres_ai_mon', 'postgres_ai.pg_statistic', 'SELECT') as ok"
      );
      assert.equal(viewOk.rows[0].ok, true);
      const explainFnOk = await c.query(
        "select has_function_privilege('postgres_ai_mon', 'postgres_ai.explain_generic(text, text, text)', 'EXECUTE') as ok"
      );
      assert.equal(explainFnOk.rows[0].ok, true);
      const tableDescribeFnOk = await c.query(
        "select has_function_privilege('postgres_ai_mon', 'postgres_ai.table_describe(text)', 'EXECUTE') as ok"
      );
      assert.equal(tableDescribeFnOk.rows[0].ok, true);
      const sp = await c.query("select rolconfig from pg_roles where rolname='postgres_ai_mon'");
      assert.ok(Array.isArray(sp.rows[0].rolconfig));
      assert.ok(sp.rows[0].rolconfig.some((v) => String(v).includes("search_path=")));
      assert.ok(sp.rows[0].rolconfig.some((v) => String(v).includes("postgres_ai")));
      await c.end();
    }

    // Run init again (idempotent).
    {
      const r = await runCliInit([pg.adminUri, "--password", "correctpw", "--skip-optional-permissions"]);
      assert.equal(r.status, 0, r.stderr || r.stdout);
    }
  }
);

test("integration: prepare-db reports nicely when lacking permissions", { skip: !havePostgresBinaries() }, async (t) => {
  const pg = await withTempPostgres(t);
  const { Client } = require("pg");

  // Create limited user that can connect but cannot create roles / grant.
  const limitedPw = "limitedpw";
  {
    const c = new Client({ connectionString: pg.adminUri });
    await c.connect();
    await c.query(`do $$ begin
      if not exists (select 1 from pg_roles where rolname='limited') then
        begin
          create role limited login password ${sqlLiteral(limitedPw)};
        exception when duplicate_object then
          null;
        end;
      end if;
    end $$;`);
    await c.query("grant connect on database testdb to limited");
    await c.end();
  }

  const limitedUri = `postgresql://limited:${limitedPw}@127.0.0.1:${pg.port}/testdb`;
  const r = await runCliInit([limitedUri, "--password", "monpw", "--skip-optional-permissions"]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /Error: prepare-db:/);
  // Should include step context and hint.
  assert.match(r.stderr, /Failed at step "/);
  assert.match(r.stderr, /Fix: connect as a superuser/i);
});

test("integration: prepare-db --verify returns 0 when ok and non-zero when missing", { skip: !havePostgresBinaries() }, async (t) => {
  const pg = await withTempPostgres(t);
  const { Client } = require("pg");

  // Prepare: run init
  {
    const r = await runCliInit([pg.adminUri, "--password", "monpw", "--skip-optional-permissions"]);
    assert.equal(r.status, 0, r.stderr || r.stdout);
  }

  // Verify should pass
  {
    const r = await runCliInit([pg.adminUri, "--verify", "--skip-optional-permissions"]);
    assert.equal(r.status, 0, r.stderr || r.stdout);
    assert.match(r.stdout, /prepare-db verify: OK/i);
  }

  // Break a required privilege and ensure verify fails
  {
    const c = new Client({ connectionString: pg.adminUri });
    await c.connect();
    // pg_catalog tables are often readable via PUBLIC by default; revoke from PUBLIC too so the failure is deterministic.
    await c.query("revoke select on pg_catalog.pg_index from public");
    await c.query("revoke select on pg_catalog.pg_index from postgres_ai_mon");
    await c.end();
  }
  {
    const r = await runCliInit([pg.adminUri, "--verify", "--skip-optional-permissions"]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /prepare-db verify failed/i);
    assert.match(r.stderr, /pg_catalog\.pg_index/i);
  }
});

test("integration: prepare-db --reset-password updates the monitoring role login password", { skip: !havePostgresBinaries() }, async (t) => {
  const pg = await withTempPostgres(t);
  const { Client } = require("pg");

  // Initial setup with password pw1
  {
    const r = await runCliInit([pg.adminUri, "--password", "pw1", "--skip-optional-permissions"]);
    assert.equal(r.status, 0, r.stderr || r.stdout);
  }

  // Reset to pw2
  {
    const r = await runCliInit([pg.adminUri, "--reset-password", "--password", "pw2", "--skip-optional-permissions"]);
    assert.equal(r.status, 0, r.stderr || r.stdout);
    assert.match(r.stdout, /password reset/i);
  }

  // Connect as monitoring user with new password should work
  {
    const c = new Client({
      connectionString: `postgresql://postgres_ai_mon:pw2@127.0.0.1:${pg.port}/testdb`,
    });
    await c.connect();
    const ok = await c.query("select 1 as ok");
    assert.equal(ok.rows[0].ok, 1);
    await c.end();
  }
});

test("integration: table_describe works with different object types", { skip: !havePostgresBinaries() }, async (t) => {
  const pg = await withTempPostgres(t);
  const { Client } = require("pg");

  // Run init first
  {
    const r = await runCliInit([pg.adminUri, "--password", "pw1", "--skip-optional-permissions"]);
    assert.equal(r.status, 0, r.stderr || r.stdout);
  }

  const c = new Client({ connectionString: pg.adminUri });
  await c.connect();

  try {
    // Create test objects
    await c.query(`
      -- Regular table with various features
      create table test_table (
        id serial primary key,
        name text not null,
        email text unique,
        status text default 'active' check (status in ('active', 'inactive')),
        created_at timestamptz default now()
      );
      create index test_table_name_idx on test_table(name);

      -- Another table with FK
      create table test_child (
        id serial primary key,
        parent_id int references test_table(id)
      );

      -- Partitioned table
      create table test_partitioned (
        id serial,
        created_at date not null,
        data text
      ) partition by range (created_at);

      create table test_partitioned_2024 partition of test_partitioned
        for values from ('2024-01-01') to ('2025-01-01');
      create table test_partitioned_2025 partition of test_partitioned
        for values from ('2025-01-01') to ('2026-01-01');

      -- View
      create view test_view as select id, name from test_table where status = 'active';

      -- Materialized view
      create materialized view test_matview as select id, name from test_table;
      create unique index test_matview_id_idx on test_matview(id);

      -- Sequence (for error test)
      create sequence test_seq;
    `);

    // NOTE: the column name of `select postgres_ai.table_describe(...)` is driver-dependent
    // (often defaults to function name). Alias it to keep tests stable.

    // Test regular table
    {
      const res = await c.query("select postgres_ai.table_describe('test_table') as result");
      const output = res.rows[0].result;
      // `format('%I')` only quotes when needed, so accept quoted or unquoted identifiers.
      assert.match(output, /Table:\s+(?:"public"\."test_table"|public\.test_table)/);
      assert.match(output, /Type: table/);
      assert.match(output, /relpages:/);
      assert.match(output, /reltuples:/);
      assert.match(output, /Columns:/);
      assert.match(output, /\bid integer NOT NULL\b/);
      assert.match(output, /name text NOT NULL/);
      assert.match(output, /email text/);
      assert.match(output, /status text.*DEFAULT/i);
      assert.match(output, /Indexes:/);
      assert.match(output, /PRIMARY KEY:/);
      assert.match(output, /UNIQUE:/);
      assert.match(output, /INDEX:.*test_table_name_idx/);
      assert.match(output, /Constraints:/);
      assert.match(output, /CHECK:/);
      assert.match(output, /Referenced by:/);
      assert.match(output, /test_child/);
    }

    // Test partitioned table
    {
      const res = await c.query("select postgres_ai.table_describe('test_partitioned') as result");
      const output = res.rows[0].result;
      assert.match(output, /Type: partitioned table/);
      assert.match(output, /Partitioning:/);
      // Output formatting can vary (e.g., "R BY RANGE (...)" vs "RANGE BY (...)").
      assert.match(output, /\bBY RANGE\b/i);
      assert.match(output, /\bcreated_at\b/i);
      assert.match(output, /test_partitioned_2024/);
      assert.match(output, /test_partitioned_2025/);
      assert.match(output, /Total partitions: 2/);
    }

    // Test partition
    {
      const res = await c.query("select postgres_ai.table_describe('test_partitioned_2024') as result");
      const output = res.rows[0].result;
      assert.match(output, /Type: table/);
      assert.match(output, /Partition of:/);
      assert.match(output, /test_partitioned/);
      assert.match(output, /FOR VALUES/);
    }

    // Test view
    {
      const res = await c.query("select postgres_ai.table_describe('test_view') as result");
      const output = res.rows[0].result;
      assert.match(output, /Type: view/);
      assert.match(output, /Columns:/);
      assert.match(output, /Definition:/);
      assert.match(output, /SELECT[\s\S]*FROM[\s\S]*test_table/i);
      // Views should NOT have Indexes or Constraints sections
      assert.doesNotMatch(output, /^Indexes:/m);
      assert.doesNotMatch(output, /^Constraints:/m);
    }

    // Test materialized view
    {
      const res = await c.query("select postgres_ai.table_describe('test_matview') as result");
      const output = res.rows[0].result;
      assert.match(output, /Type: materialized view/);
      assert.match(output, /Columns:/);
      assert.match(output, /Definition:/);
      assert.match(output, /Indexes:/);
      assert.match(output, /UNIQUE:.*test_matview_id_idx/);
      // Mat views should NOT have Constraints section
      assert.doesNotMatch(output, /^Constraints:/m);
    }

    // Test sequence (should error)
    {
      await assert.rejects(
        c.query("select postgres_ai.table_describe('test_seq')"),
        /table_describe does not support sequences/
      );
    }

    // Test index (should error)
    {
      await assert.rejects(
        c.query("select postgres_ai.table_describe('test_table_name_idx')"),
        /table_describe does not support indexes/
      );
    }
  } finally {
    await c.end();
  }
});


