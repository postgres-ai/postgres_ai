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
  const res = spawnSync(node, [cliPath, "init", ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return res;
}

test(
  "integration: init supports URI / conninfo / psql-like connection styles",
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
  "integration: init requires explicit monitoring password in non-interactive mode (unless --print-password)",
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
  "integration: init fixes slightly-off permissions idempotently",
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
        "select has_table_privilege('postgres_ai_mon', 'public.pg_statistic', 'SELECT') as ok"
      );
      assert.equal(viewOk.rows[0].ok, true);
      const sp = await c.query("select rolconfig from pg_roles where rolname='postgres_ai_mon'");
      assert.ok(Array.isArray(sp.rows[0].rolconfig));
      assert.ok(sp.rows[0].rolconfig.some((v) => String(v).includes("search_path=")));
      await c.end();
    }

    // Run init again (idempotent).
    {
      const r = await runCliInit([pg.adminUri, "--password", "correctpw", "--skip-optional-permissions"]);
      assert.equal(r.status, 0, r.stderr || r.stdout);
    }
  }
);

test("integration: init reports nicely when lacking permissions", { skip: !havePostgresBinaries() }, async (t) => {
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
  assert.match(r.stderr, /Error: init:/);
  // Should include step context and hint.
  assert.match(r.stderr, /Failed at step "/);
  assert.match(r.stderr, /Fix: connect as a superuser/i);
});

test("integration: init --verify returns 0 when ok and non-zero when missing", { skip: !havePostgresBinaries() }, async (t) => {
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
    assert.match(r.stdout, /init verify: OK/i);
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
    assert.match(r.stderr, /init verify failed/i);
    assert.match(r.stderr, /pg_catalog\.pg_index/i);
  }
});

test("integration: init --reset-password updates the monitoring role login password", { skip: !havePostgresBinaries() }, async (t) => {
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


