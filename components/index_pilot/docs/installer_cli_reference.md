## Installer CLI reference

```bash
Usage: ./index_pilot.sh <subcommand> [options]

Subcommands:
  install-control     Install schema/functions into control DB
  register-target     Register a target DB via postgres_fdw
  verify              Verify version, permissions, FDW and environment
  uninstall           Uninstall from control DB (and optionally drop servers)

Common options:
  -H, --host HOST           PostgreSQL host
  -P, --port PORT           PostgreSQL port
  -U, --user USER           PostgreSQL user
  -W, --password PASS       PostgreSQL password (prefer PGPASSWORD env)
  -C, --control-db NAME     Control database name
  --fdw-host HOST           Hostname to use inside FDW (default: same as --host)
  --no-create-db            Do not create control DB if missing
  -q, --quiet               Less verbose psql output

register-target options:
  -T, --target-db NAME      Target database name (required)
  --server-name NAME        FDW server name (default: target_<target-db>)
  --force                   Recreate FDW server and upsert registration

uninstall options:
  --drop-servers            Attempt to drop FDW servers from target_databases

Environment:
  PGPASSWORD                PostgreSQL password (safer than -W)
```

### Defaults and prerequisites
- Host: `localhost`; Port: `5432`.
- User: current `$USER` by default.
- Control DB: `index_pilot_control`.
- Quiet flags: psql runs with `-X` by default; add `-q` for quieter output.
- Required: `psql` must be available in PATH.

### Examples
```bash
# Install into control DB
PGPASSWORD='your_password' \
  ./index_pilot.sh install-control -H <host> -U <user> -C <control_db>

# Register a target (creates/updates FDW server and user mapping, tests connection)
PGPASSWORD='your_password' \
  ./index_pilot.sh register-target -H <host> -U <user> -C <control_db> \
  -T <db> --fdw-host <target_host>

# Force recreate server and update registration, custom server name
PGPASSWORD='your_password' \
  ./index_pilot.sh register-target -H <host> -U <user> -C <control_db> \
  -T <db> --server-name target_<db> --force

# Verify installation and environment
PGPASSWORD='your_password' ./index_pilot.sh verify -H <host> -U <user> -C <control_db>

# Uninstall and (optionally) drop FDW servers referenced by inventory
PGPASSWORD='your_password' ./index_pilot.sh uninstall -H <host> -U <user> -C <control_db> --drop-servers
```

### Managed services notes
- Creates user mappings for the current user on the FDW server.
- Use `--fdw-host` reachable from the database server instance (container/VM network context), not necessarily your client.

