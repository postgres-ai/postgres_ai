export function maskSecret(secret: string): string {
  if (!secret) return "";
  if (secret.length <= 8) return "****";
  if (secret.length <= 16) return `${secret.slice(0, 4)}${"*".repeat(secret.length - 8)}${secret.slice(-4)}`;
  return `${secret.slice(0, Math.min(12, secret.length - 8))}${"*".repeat(Math.max(4, secret.length - 16))}${secret.slice(-4)}`;
}


export interface RootOptsLike {
  apiBaseUrl?: string;
  uiBaseUrl?: string;
}

export interface ConfigLike {
  baseUrl?: string | null;
}

export interface ResolvedBaseUrls {
  apiBaseUrl: string;
  uiBaseUrl: string;
}

/**
 * Normalize a base URL by trimming a single trailing slash and validating.
 * @throws Error if the URL is invalid
 */
export function normalizeBaseUrl(value: string): string {
  const trimmed = (value || "").replace(/\/$/, "");
  try {
    // Validate
    // eslint-disable-next-line no-new
    new URL(trimmed);
  } catch {
    throw new Error(`Invalid base URL: ${value}`);
  }
  return trimmed;
}

/**
 * Resolve API and UI base URLs using precedence and normalize them.
 * Precedence (API): opts.apiBaseUrl → env.PGAI_API_BASE_URL → cfg.baseUrl → default
 * Precedence (UI):  opts.uiBaseUrl  → env.PGAI_UI_BASE_URL  → default
 */
export function resolveBaseUrls(
  opts?: RootOptsLike,
  cfg?: ConfigLike,
  defaults: { apiBaseUrl?: string; uiBaseUrl?: string } = {}
): ResolvedBaseUrls {
  const defApi = defaults.apiBaseUrl || "https://postgres.ai/api/general/";
  const defUi = defaults.uiBaseUrl || "https://console.postgres.ai";

  const apiCandidate = (opts?.apiBaseUrl || process.env.PGAI_API_BASE_URL || cfg?.baseUrl || defApi) as string;
  const uiCandidate = (opts?.uiBaseUrl || process.env.PGAI_UI_BASE_URL || defUi) as string;

  return {
    apiBaseUrl: normalizeBaseUrl(apiCandidate),
    uiBaseUrl: normalizeBaseUrl(uiCandidate),
  };
}

