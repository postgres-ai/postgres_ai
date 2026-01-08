/**
 * Supabase Management API client for database operations.
 *
 * This module provides an alternative to direct PostgreSQL connections by using
 * the Supabase Management API to execute SQL queries.
 *
 * API Reference: https://supabase.com/docs/reference/api/introduction
 * Endpoint: POST /v1/projects/{ref}/database/query
 */

const SUPABASE_API_BASE = "https://api.supabase.com";

export type SupabaseConfig = {
  /** Supabase project reference (e.g., "abc123xyz") */
  projectRef: string;
  /** Supabase Management API access token (Personal Access Token) */
  accessToken: string;
};

/**
 * PostgreSQL-compatible error structure.
 * Mirrors the error fields from node-postgres for consistent error handling.
 */
export type PgCompatibleError = Error & {
  code?: string;
  detail?: string;
  hint?: string;
  position?: string;
  internalPosition?: string;
  internalQuery?: string;
  where?: string;
  schema?: string;
  table?: string;
  column?: string;
  dataType?: string;
  constraint?: string;
  file?: string;
  line?: string;
  routine?: string;
  // Supabase-specific fields (mapped to pg-compatible structure)
  supabaseErrorCode?: string;
  httpStatus?: number;
};

/**
 * Result from Supabase Management API query endpoint.
 */
export type SupabaseQueryResult = {
  rows: Record<string, unknown>[];
  rowCount: number;
};

/**
 * Raw response from Supabase Management API.
 */
type SupabaseApiResponse = {
  // Success case: array of rows
  // Error case: { code, message, ... }
  error?: {
    code?: string;
    message?: string;
    details?: string;
    hint?: string;
  };
  // The API returns the result directly (array) on success
} | Record<string, unknown>[];

/**
 * Supabase Management API client for executing SQL queries.
 */
export class SupabaseClient {
  private config: SupabaseConfig;

  constructor(config: SupabaseConfig) {
    if (!config.projectRef) {
      throw new Error("Supabase project reference is required");
    }
    if (!config.accessToken) {
      throw new Error("Supabase access token is required");
    }
    this.config = config;
  }

  /**
   * Execute a SQL query via the Supabase Management API.
   *
   * @param sql The SQL query to execute
   * @param readOnly Whether this is a read-only query (default: false for DDL/DML)
   * @returns Query result with rows and rowCount
   * @throws PgCompatibleError on failure
   */
  async query(sql: string, readOnly = false): Promise<SupabaseQueryResult> {
    const url = `${SUPABASE_API_BASE}/v1/projects/${this.config.projectRef}/database/query`;

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.config.accessToken}`,
      },
      body: JSON.stringify({
        query: sql,
        read_only: readOnly,
      }),
    });

    const body = await response.text();
    let data: SupabaseApiResponse;

    try {
      data = JSON.parse(body);
    } catch {
      // If we can't parse JSON, create an error with the raw body
      throw this.createPgError({
        message: `Supabase API returned non-JSON response: ${body.slice(0, 200)}`,
        httpStatus: response.status,
      });
    }

    // Handle HTTP errors
    if (!response.ok) {
      throw this.parseApiError(data, response.status);
    }

    // Handle explicit error response
    if (data && typeof data === "object" && "error" in data && data.error) {
      throw this.parseApiError(data, response.status);
    }

    // Success: API returns array of rows directly
    const rows = Array.isArray(data) ? data : [];
    return {
      rows: rows as Record<string, unknown>[],
      rowCount: rows.length,
    };
  }

  /**
   * Test connection by executing a simple query.
   */
  async testConnection(): Promise<{ database: string; version: string }> {
    const result = await this.query(
      "SELECT current_database() as db, version() as version",
      true
    );
    const row = result.rows[0] ?? {};
    return {
      database: String(row.db ?? ""),
      version: String(row.version ?? ""),
    };
  }

  /**
   * Get current database name.
   */
  async getCurrentDatabase(): Promise<string> {
    const result = await this.query("SELECT current_database() as db", true);
    const row = result.rows[0] ?? {};
    return String(row.db ?? "");
  }

  /**
   * Parse Supabase API error and convert to PostgreSQL-compatible error.
   */
  private parseApiError(
    data: SupabaseApiResponse,
    httpStatus: number
  ): PgCompatibleError {
    // Handle different error formats from Supabase API
    if (data && typeof data === "object" && !Array.isArray(data)) {
      const errObj = "error" in data && data.error ? data.error : data;

      // Check for PostgreSQL error embedded in the response
      // Supabase forwards PostgreSQL errors with their original structure
      const pgCode = this.extractPgErrorCode(errObj);
      const message = this.extractErrorMessage(errObj);
      const detail = this.extractField(errObj, ["details", "detail"]);
      const hint = this.extractField(errObj, ["hint"]);

      return this.createPgError({
        message,
        code: pgCode,
        detail,
        hint,
        httpStatus,
        supabaseErrorCode:
          typeof errObj === "object" && errObj && "code" in errObj
            ? String((errObj as Record<string, unknown>).code ?? "")
            : undefined,
      });
    }

    return this.createPgError({
      message: `Supabase API error (HTTP ${httpStatus})`,
      httpStatus,
    });
  }

  /**
   * Extract PostgreSQL error code from various error formats.
   * Supabase may return errors as:
   * - { code: "42501", ... } (PostgreSQL error code)
   * - { code: "PGRST...", ... } (PostgREST error code)
   * - { error: { code: "...", ... } }
   */
  private extractPgErrorCode(errObj: unknown): string | undefined {
    if (!errObj || typeof errObj !== "object") return undefined;

    const obj = errObj as Record<string, unknown>;

    // Direct code field
    if (typeof obj.code === "string") {
      const code = obj.code;
      // PostgreSQL error codes are 5 characters (e.g., "42501")
      if (/^\d{5}$/.test(code)) {
        return code;
      }
      // Map common Supabase/PostgREST error codes to PostgreSQL equivalents
      return this.mapSupabaseCodeToPg(code);
    }

    return undefined;
  }

  /**
   * Map Supabase/PostgREST error codes to PostgreSQL equivalents.
   */
  private mapSupabaseCodeToPg(code: string): string | undefined {
    // PostgREST error codes: https://postgrest.org/en/stable/references/errors.html
    const mapping: Record<string, string> = {
      // Authentication/Authorization
      PGRST301: "28000", // invalid_authorization_specification
      PGRST302: "28P01", // invalid_password
      // Permission errors
      "42501": "42501", // insufficient_privilege (pass through)
      PGRST000: "42501", // permission denied (generic)
      // Syntax errors
      "42601": "42601", // syntax_error (pass through)
      // Object errors
      "42P01": "42P01", // undefined_table (pass through)
      PGRST200: "42P01", // table not found
      "42883": "42883", // undefined_function (pass through)
      // Connection errors
      "08000": "08000", // connection_exception (pass through)
      "08003": "08003", // connection_does_not_exist (pass through)
      "08006": "08006", // connection_failure (pass through)
      // Duplicate object
      "42710": "42710", // duplicate_object (pass through)
    };

    return mapping[code];
  }

  /**
   * Extract error message from various error formats.
   */
  private extractErrorMessage(errObj: unknown): string {
    if (!errObj || typeof errObj !== "object") {
      return "Unknown Supabase API error";
    }

    const obj = errObj as Record<string, unknown>;

    // Try common message fields
    for (const field of ["message", "error", "msg", "description"]) {
      if (typeof obj[field] === "string" && obj[field]) {
        return obj[field] as string;
      }
    }

    // If error is nested, try to extract from it
    if (obj.error && typeof obj.error === "object") {
      return this.extractErrorMessage(obj.error);
    }

    return "Unknown Supabase API error";
  }

  /**
   * Extract a field from error object, trying multiple possible field names.
   */
  private extractField(
    errObj: unknown,
    fieldNames: string[]
  ): string | undefined {
    if (!errObj || typeof errObj !== "object") return undefined;

    const obj = errObj as Record<string, unknown>;

    for (const field of fieldNames) {
      if (typeof obj[field] === "string" && obj[field]) {
        return obj[field] as string;
      }
    }

    return undefined;
  }

  /**
   * Create a PostgreSQL-compatible error object.
   */
  private createPgError(opts: {
    message: string;
    code?: string;
    detail?: string;
    hint?: string;
    httpStatus?: number;
    supabaseErrorCode?: string;
  }): PgCompatibleError {
    const err = new Error(opts.message) as PgCompatibleError;

    if (opts.code) err.code = opts.code;
    if (opts.detail) err.detail = opts.detail;
    if (opts.hint) err.hint = opts.hint;
    if (opts.httpStatus) err.httpStatus = opts.httpStatus;
    if (opts.supabaseErrorCode) err.supabaseErrorCode = opts.supabaseErrorCode;

    return err;
  }
}

/**
 * Resolve Supabase configuration from options and environment variables.
 */
export function resolveSupabaseConfig(opts: {
  accessToken?: string;
  projectRef?: string;
}): SupabaseConfig {
  const accessToken =
    opts.accessToken?.trim() ||
    process.env.SUPABASE_ACCESS_TOKEN?.trim() ||
    "";

  const projectRef =
    opts.projectRef?.trim() || process.env.SUPABASE_PROJECT_REF?.trim() || "";

  if (!accessToken) {
    throw new Error(
      "Supabase access token is required.\n" +
        "Provide it via --supabase-access-token or SUPABASE_ACCESS_TOKEN environment variable.\n" +
        "Generate a token at: https://supabase.com/dashboard/account/tokens"
    );
  }

  if (!projectRef) {
    throw new Error(
      "Supabase project reference is required.\n" +
        "Provide it via --supabase-project-ref or SUPABASE_PROJECT_REF environment variable.\n" +
        "Find your project ref in the Supabase dashboard URL: https://supabase.com/dashboard/project/<ref>"
    );
  }

  return { accessToken, projectRef };
}

/**
 * Extract project reference from a Supabase database URL.
 * Supabase database URLs typically look like:
 *   postgresql://postgres:[PASSWORD]@db.[PROJECT_REF].supabase.co:5432/postgres
 *
 * @param dbUrl PostgreSQL connection URL
 * @returns Project reference if found, undefined otherwise
 */
export function extractProjectRefFromUrl(dbUrl: string): string | undefined {
  try {
    const url = new URL(dbUrl);
    const host = url.hostname;

    // Match db.<ref>.supabase.co or <ref>.supabase.co patterns
    const match = host.match(/^(?:db\.)?([^.]+)\.supabase\.co$/i);
    if (match && match[1]) {
      return match[1];
    }

    // Also check for pooler URLs: <project-ref>.pooler.supabase.com
    const poolerMatch = host.match(/^([^.]+)\.pooler\.supabase\.com$/i);
    if (poolerMatch && poolerMatch[1]) {
      return poolerMatch[1];
    }

    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Apply init plan steps via Supabase Management API.
 * Mirrors the behavior of applyInitPlan() in init.ts but uses Supabase API.
 */
export async function applyInitPlanViaSupabase(params: {
  client: SupabaseClient;
  plan: {
    monitoringUser: string;
    database: string;
    steps: Array<{
      name: string;
      sql: string;
      params?: unknown[];
      optional?: boolean;
    }>;
  };
  verbose?: boolean;
}): Promise<{ applied: string[]; skippedOptional: string[] }> {
  const applied: string[] = [];
  const skippedOptional: string[] = [];

  // Helper to execute a step (each step is wrapped in BEGIN/COMMIT)
  const executeStep = async (step: {
    name: string;
    sql: string;
    optional?: boolean;
  }): Promise<void> => {
    // Supabase API handles transactions automatically for single statements
    // For multi-statement SQL, we wrap in a transaction
    const wrappedSql = `BEGIN;\n${step.sql}\nCOMMIT;`;

    try {
      await params.client.query(wrappedSql, false);
    } catch (e) {
      // On error, attempt rollback (may already be rolled back by Supabase)
      try {
        await params.client.query("ROLLBACK;", false);
      } catch {
        // ignore rollback errors
      }
      throw e;
    }
  };

  // Apply non-optional steps first
  for (const step of params.plan.steps.filter((s) => !s.optional)) {
    try {
      if (params.verbose) {
        console.log(`Executing step: ${step.name}`);
      }
      await executeStep(step);
      applied.push(step.name);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const errAny = e as PgCompatibleError;
      const wrapped: PgCompatibleError = new Error(
        `Failed at step "${step.name}": ${msg}`
      ) as PgCompatibleError;

      // Preserve PostgreSQL error fields for consistent error handling
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
        "httpStatus",
        "supabaseErrorCode",
      ] as const;

      for (const field of pgErrorFields) {
        if (errAny[field] !== undefined) {
          (wrapped as unknown as Record<string, unknown>)[field] = errAny[field];
        }
      }

      if (e instanceof Error && e.stack) {
        wrapped.stack = e.stack;
      }

      throw wrapped;
    }
  }

  // Apply optional steps (failures don't abort)
  for (const step of params.plan.steps.filter((s) => s.optional)) {
    try {
      if (params.verbose) {
        console.log(`Executing optional step: ${step.name}`);
      }
      await executeStep(step);
      applied.push(step.name);
    } catch {
      skippedOptional.push(step.name);
      // best-effort: ignore errors for optional steps
    }
  }

  return { applied, skippedOptional };
}

/**
 * Verify init setup via Supabase Management API.
 * Mirrors the behavior of verifyInitSetup() in init.ts but uses Supabase API.
 */
export async function verifyInitSetupViaSupabase(params: {
  client: SupabaseClient;
  database: string;
  monitoringUser: string;
  includeOptionalPermissions: boolean;
}): Promise<{
  ok: boolean;
  missingRequired: string[];
  missingOptional: string[];
}> {
  const missingRequired: string[] = [];
  const missingOptional: string[] = [];

  const role = params.monitoringUser;
  const db = params.database;

  // Check if role exists
  const roleRes = await params.client.query(
    `SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = '${escapeLiteral(role)}'`,
    true
  );
  const roleExists = roleRes.rowCount > 0;

  if (!roleExists) {
    missingRequired.push(`role "${role}" does not exist`);
    return { ok: false, missingRequired, missingOptional };
  }

  // Check CONNECT privilege
  const connectRes = await params.client.query(
    `SELECT has_database_privilege('${escapeLiteral(role)}', '${escapeLiteral(db)}', 'CONNECT') as ok`,
    true
  );
  if (!connectRes.rows?.[0]?.ok) {
    missingRequired.push(`CONNECT on database "${db}"`);
  }

  // Check pg_monitor membership
  const pgMonitorRes = await params.client.query(
    `SELECT pg_has_role('${escapeLiteral(role)}', 'pg_monitor', 'member') as ok`,
    true
  );
  if (!pgMonitorRes.rows?.[0]?.ok) {
    missingRequired.push("membership in role pg_monitor");
  }

  // Check SELECT on pg_index
  const pgIndexRes = await params.client.query(
    `SELECT has_table_privilege('${escapeLiteral(role)}', 'pg_catalog.pg_index', 'SELECT') as ok`,
    true
  );
  if (!pgIndexRes.rows?.[0]?.ok) {
    missingRequired.push("SELECT on pg_catalog.pg_index");
  }

  // Check postgres_ai schema
  const schemaExistsRes = await params.client.query(
    `SELECT has_schema_privilege('${escapeLiteral(role)}', 'postgres_ai', 'USAGE') as ok`,
    true
  );
  if (!schemaExistsRes.rows?.[0]?.ok) {
    missingRequired.push("USAGE on schema postgres_ai");
  }

  // Check pg_statistic view
  const viewExistsRes = await params.client.query(
    "SELECT to_regclass('postgres_ai.pg_statistic') IS NOT NULL as ok",
    true
  );
  if (!viewExistsRes.rows?.[0]?.ok) {
    missingRequired.push("view postgres_ai.pg_statistic exists");
  } else {
    const viewPrivRes = await params.client.query(
      `SELECT has_table_privilege('${escapeLiteral(role)}', 'postgres_ai.pg_statistic', 'SELECT') as ok`,
      true
    );
    if (!viewPrivRes.rows?.[0]?.ok) {
      missingRequired.push("SELECT on view postgres_ai.pg_statistic");
    }
  }

  // Check USAGE on public schema
  const schemaUsageRes = await params.client.query(
    `SELECT has_schema_privilege('${escapeLiteral(role)}', 'public', 'USAGE') as ok`,
    true
  );
  if (!schemaUsageRes.rows?.[0]?.ok) {
    missingRequired.push("USAGE on schema public");
  }

  // Check search_path
  const rolcfgRes = await params.client.query(
    `SELECT rolconfig FROM pg_catalog.pg_roles WHERE rolname = '${escapeLiteral(role)}'`,
    true
  );
  const rolconfig = rolcfgRes.rows?.[0]?.rolconfig as string[] | null;
  const spLine = Array.isArray(rolconfig)
    ? rolconfig.find((v: string) => String(v).startsWith("search_path="))
    : undefined;
  if (typeof spLine !== "string" || !spLine) {
    missingRequired.push("role search_path is set");
  } else {
    const sp = spLine.toLowerCase();
    if (
      !sp.includes("postgres_ai") ||
      !sp.includes("public") ||
      !sp.includes("pg_catalog")
    ) {
      missingRequired.push(
        "role search_path includes postgres_ai, public and pg_catalog"
      );
    }
  }

  // Check helper functions
  const explainFnRes = await params.client.query(
    `SELECT has_function_privilege('${escapeLiteral(role)}', 'postgres_ai.explain_generic(text, text, text)', 'EXECUTE') as ok`,
    true
  );
  if (!explainFnRes.rows?.[0]?.ok) {
    missingRequired.push(
      "EXECUTE on postgres_ai.explain_generic(text, text, text)"
    );
  }

  const tableDescribeFnRes = await params.client.query(
    `SELECT has_function_privilege('${escapeLiteral(role)}', 'postgres_ai.table_describe(text)', 'EXECUTE') as ok`,
    true
  );
  if (!tableDescribeFnRes.rows?.[0]?.ok) {
    missingRequired.push("EXECUTE on postgres_ai.table_describe(text)");
  }

  // Optional permissions
  if (params.includeOptionalPermissions) {
    // RDS tools extension
    const extRes = await params.client.query(
      "SELECT 1 FROM pg_extension WHERE extname = 'rds_tools'",
      true
    );
    if (extRes.rowCount === 0) {
      missingOptional.push("extension rds_tools");
    } else {
      const fnRes = await params.client.query(
        `SELECT has_function_privilege('${escapeLiteral(role)}', 'rds_tools.pg_ls_multixactdir()', 'EXECUTE') as ok`,
        true
      );
      if (!fnRes.rows?.[0]?.ok) {
        missingOptional.push("EXECUTE on rds_tools.pg_ls_multixactdir()");
      }
    }

    // Self-managed extras
    const optionalFns = [
      "pg_catalog.pg_stat_file(text)",
      "pg_catalog.pg_stat_file(text, boolean)",
      "pg_catalog.pg_ls_dir(text)",
      "pg_catalog.pg_ls_dir(text, boolean, boolean)",
    ];
    for (const fn of optionalFns) {
      const fnRes = await params.client.query(
        `SELECT has_function_privilege('${escapeLiteral(role)}', '${fn}', 'EXECUTE') as ok`,
        true
      );
      if (!fnRes.rows?.[0]?.ok) {
        missingOptional.push(`EXECUTE on ${fn}`);
      }
    }
  }

  return {
    ok: missingRequired.length === 0,
    missingRequired,
    missingOptional,
  };
}

/**
 * Escape a string literal for use in SQL.
 * Note: This is for dynamic query building where parameterized queries aren't possible.
 */
function escapeLiteral(value: string): string {
  // Escape single quotes by doubling them
  return value.replace(/'/g, "''");
}
