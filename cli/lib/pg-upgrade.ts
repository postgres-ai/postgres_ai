/**
 * PostgreSQL upgrade utilities for handling major version migrations
 */

import * as fs from "fs";
import * as childProcess from "child_process";

/**
 * Spawn sync helper for Docker commands
 */
function spawnSync(
  cmd: string,
  args: string[],
  options?: { stdio?: "pipe" | "ignore" | "inherit"; encoding?: string }
): { status: number | null; stdout: string; stderr: string } {
  const result = childProcess.spawnSync(cmd, args, {
    stdio: options?.stdio === "inherit" ? "inherit" : "pipe",
    encoding: "utf8",
  });
  return {
    status: result.status,
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    stderr: typeof result.stderr === "string" ? result.stderr : "",
  };
}

/**
 * Get PostgreSQL major version from a running container
 * @returns Major version number (e.g., 15, 17, 18) or null if container not running
 */
export function getRunningPostgresVersion(containerName: string): number | null {
  try {
    const result = spawnSync(
      "docker",
      ["exec", containerName, "psql", "-U", "postgres", "-t", "-c", "SHOW server_version_num"],
      { stdio: "pipe", encoding: "utf8" }
    );
    if (result.status === 0 && result.stdout) {
      const versionNum = parseInt(result.stdout.trim(), 10);
      if (!isNaN(versionNum)) {
        return Math.floor(versionNum / 10000); // e.g., 150000 -> 15
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Get target PostgreSQL major version from docker-compose.yml
 * @returns Major version number or null if not found
 */
export function getTargetPostgresVersion(composeFilePath: string): number | null {
  try {
    const content = fs.readFileSync(composeFilePath, "utf8");
    return parsePostgresVersionFromCompose(content);
  } catch {
    return null;
  }
}

/**
 * Parse PostgreSQL version from docker-compose.yml content
 * Exported for testing purposes
 */
export function parsePostgresVersionFromCompose(content: string): number | null {
  // Match postgres:XX image tag for sink-postgres service
  const match = content.match(/sink-postgres:[\s\S]*?image:\s*postgres:(\d+)/);
  if (match && match[1]) {
    return parseInt(match[1], 10);
  }
  return null;
}

/**
 * Build the shell script for running pg_upgrade inside a container
 */
export function buildUpgradeScript(oldVersion: number, newVersion: number): string {
  return `
set -e

echo "Installing PostgreSQL ${oldVersion} binaries..."
apt-get update -qq
apt-get install -y -qq postgresql-${oldVersion} >/dev/null 2>&1

echo "Preparing data directories..."
mkdir -p /var/lib/postgresql/${newVersion}/data
chown postgres:postgres /var/lib/postgresql/${newVersion}/data
chmod 700 /var/lib/postgresql/${newVersion}/data

# Initialize new data directory
echo "Initializing new PostgreSQL ${newVersion} cluster..."
su postgres -c "/usr/lib/postgresql/${newVersion}/bin/initdb -D /var/lib/postgresql/${newVersion}/data"

# Run pg_upgrade
echo "Running pg_upgrade..."
cd /var/lib/postgresql
su postgres -c "/usr/lib/postgresql/${newVersion}/bin/pg_upgrade \\
  --old-datadir=/var/lib/postgresql/data \\
  --new-datadir=/var/lib/postgresql/${newVersion}/data \\
  --old-bindir=/usr/lib/postgresql/${oldVersion}/bin \\
  --new-bindir=/usr/lib/postgresql/${newVersion}/bin \\
  --link"

# Replace old data with upgraded data
echo "Finalizing upgrade..."
rm -rf /var/lib/postgresql/data.old 2>/dev/null || true
mv /var/lib/postgresql/data /var/lib/postgresql/data.old
mv /var/lib/postgresql/${newVersion}/data /var/lib/postgresql/data

echo "PostgreSQL upgrade completed successfully!"
`;
}

/**
 * Run pg_upgrade to migrate PostgreSQL data between major versions
 * Uses the new postgres image with old binaries installed
 */
export async function runPgUpgrade(
  oldVersion: number,
  newVersion: number,
  volumeName: string = "postgres_ai_sink_postgres_data"
): Promise<boolean> {
  console.log(`\nMigrating PostgreSQL data from version ${oldVersion} to ${newVersion}...`);

  const containerName = "postgres-ai-pg-upgrade";
  const upgradeScript = buildUpgradeScript(oldVersion, newVersion);

  try {
    // Remove any existing upgrade container
    spawnSync("docker", ["rm", "-f", containerName], { stdio: "ignore" });

    // Run upgrade in a temporary container
    console.log("Starting upgrade container...");
    const result = spawnSync(
      "docker",
      [
        "run",
        "--rm",
        "--name", containerName,
        "-v", `${volumeName}:/var/lib/postgresql/data`,
        `postgres:${newVersion}`,
        "bash", "-c", upgradeScript
      ],
      { stdio: "inherit" }
    );

    if (result.status === 0) {
      console.log("✓ PostgreSQL upgrade completed successfully\n");
      return true;
    } else {
      console.error("✗ PostgreSQL upgrade failed");
      return false;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`PostgreSQL upgrade failed: ${message}`);
    return false;
  }
}

/**
 * Check if a PostgreSQL major version upgrade is needed
 */
export function needsPostgresUpgrade(
  currentVersion: number | null,
  targetVersion: number | null
): boolean {
  return !!(currentVersion && targetVersion && currentVersion !== targetVersion);
}
