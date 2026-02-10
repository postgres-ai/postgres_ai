import * as fs from "fs";
import * as path from "path";
import { formatHttpError, maskSecret, normalizeBaseUrl } from "./util";

const MAX_UPLOAD_SIZE = 500 * 1024 * 1024; // 500 MB
const MAX_DOWNLOAD_SIZE = 500 * 1024 * 1024; // 500 MB

const MIME_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
  ".pdf": "application/pdf",
  ".json": "application/json",
  ".xml": "application/xml",
  ".zip": "application/zip",
  ".gz": "application/gzip",
  ".tar": "application/x-tar",
  ".csv": "text/csv",
  ".txt": "text/plain",
  ".log": "text/plain",
  ".sql": "application/sql",
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".ts": "application/typescript",
  ".md": "text/markdown",
  ".yaml": "application/x-yaml",
  ".yml": "application/x-yaml",
};

export interface UploadFileMetadata {
  originalName: string;
  size: number;
  mimeType: string;
  uploadedAt: string;
  duration: number;
}

export interface UploadResult {
  success: boolean;
  url: string;
  metadata: UploadFileMetadata;
  requestId: string;
}

export interface UploadFileParams {
  apiKey: string;
  storageBaseUrl: string;
  filePath: string;
  debug?: boolean;
}

/**
 * Upload a file to the storage service.
 *
 * @param params.apiKey - API token for authentication
 * @param params.storageBaseUrl - Storage service base URL
 * @param params.filePath - Local file path to upload
 * @param params.debug - Enable debug logging
 * @returns Upload result with URL and metadata
 */
export async function uploadFile(params: UploadFileParams): Promise<UploadResult> {
  const { apiKey, storageBaseUrl, filePath, debug } = params;
  if (!apiKey) {
    throw new Error("API key is required");
  }
  if (!storageBaseUrl) {
    throw new Error("storageBaseUrl is required");
  }
  if (!filePath) {
    throw new Error("filePath is required");
  }

  const resolvedPath = path.resolve(filePath);
  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`File not found: ${resolvedPath}`);
  }
  const stat = fs.statSync(resolvedPath);
  if (!stat.isFile()) {
    throw new Error(`Not a file: ${resolvedPath}`);
  }
  if (stat.size > MAX_UPLOAD_SIZE) {
    throw new Error(`File too large: ${stat.size} bytes (max ${MAX_UPLOAD_SIZE})`);
  }

  const base = normalizeBaseUrl(storageBaseUrl);
  // Warn but don't reject HTTP — CLI needs to work with localhost during development.
  // Rejecting would require an --allow-insecure flag that adds friction for local setups.
  if (new URL(base).protocol === "http:") {
    console.error("Warning: storage URL uses HTTP — API key will be sent unencrypted");
  }
  const url = `${base}/upload`;

  // readFileSync is intentional: FormData/Blob API requires the full buffer anyway,
  // and the 500MB size check above prevents excessive memory use. Streaming would
  // need a custom multipart encoder (no native stream support in fetch FormData).
  const fileBuffer = fs.readFileSync(resolvedPath);
  const fileName = path.basename(resolvedPath);

  const ext = path.extname(fileName).toLowerCase();
  const mimeType = MIME_TYPES[ext] || "application/octet-stream";

  const formData = new FormData();
  formData.append("file", new Blob([fileBuffer], { type: mimeType }), fileName);

  const headers: Record<string, string> = {
    "access-token": apiKey,
  };

  if (debug) {
    const debugHeaders: Record<string, string> = { ...headers, "access-token": maskSecret(apiKey) };
    console.error(`Debug: Storage base URL: ${base}`);
    console.error(`Debug: POST URL: ${url}`);
    console.error(`Debug: File: ${resolvedPath} (${stat.size} bytes, ${mimeType})`);
    console.error(`Debug: Request headers: ${JSON.stringify(debugHeaders)}`);
  }

  const response = await fetch(url, {
    method: "POST",
    headers,
    body: formData,
  });

  if (debug) {
    console.error(`Debug: Response status: ${response.status}`);
    console.error(`Debug: Response headers: ${JSON.stringify(Object.fromEntries(response.headers.entries()))}`);
  }

  const data = await response.text();

  if (response.ok) {
    try {
      return JSON.parse(data) as UploadResult;
    } catch {
      throw new Error(`Failed to parse upload response: ${data}`);
    }
  } else {
    throw new Error(formatHttpError("Failed to upload file", response.status, data));
  }
}

export interface DownloadFileParams {
  apiKey: string;
  storageBaseUrl: string;
  fileUrl: string;
  outputPath?: string;
  debug?: boolean;
}

export interface DownloadResult {
  savedTo: string;
  size: number;
  mimeType: string | null;
}

/**
 * Download a file from the storage service.
 *
 * @param params.apiKey - API token for authentication
 * @param params.storageBaseUrl - Storage service base URL
 * @param params.fileUrl - File URL path (e.g. /files/123/xxx.png) or full URL
 * @param params.outputPath - Local path to save the file (default: derive from URL)
 * @param params.debug - Enable debug logging
 * @returns Download result with saved path and size
 */
export async function downloadFile(params: DownloadFileParams): Promise<DownloadResult> {
  const { apiKey, storageBaseUrl, fileUrl, outputPath, debug } = params;
  if (!apiKey) {
    throw new Error("API key is required");
  }
  if (!storageBaseUrl) {
    throw new Error("storageBaseUrl is required");
  }
  if (!fileUrl) {
    throw new Error("fileUrl is required");
  }

  const base = normalizeBaseUrl(storageBaseUrl);
  // Warn but don't reject HTTP — same rationale as uploadFile (localhost dev).
  if (new URL(base).protocol === "http:") {
    console.error("Warning: storage URL uses HTTP — API key will be sent unencrypted");
  }

  // Support both full URLs and relative paths
  let fullUrl: string;
  if (fileUrl.startsWith("http://") || fileUrl.startsWith("https://")) {
    if (!fileUrl.startsWith(base + "/")) {
      throw new Error(`URL must be under storage base URL: ${base}`);
    }
    fullUrl = fileUrl;
  } else {
    // Relative path like /files/123/xxx.png
    const relativePath = fileUrl.startsWith("/") ? fileUrl : `/${fileUrl}`;
    fullUrl = `${base}${relativePath}`;
  }

  // Derive output filename from URL if not specified
  const urlFilename = path.basename(new URL(fullUrl).pathname);
  if (!urlFilename) {
    throw new Error("Cannot derive filename from URL; please specify --output");
  }
  const saveTo = outputPath ? path.resolve(outputPath) : path.resolve(urlFilename);

  // Path traversal guard only for URL-derived filenames (untrusted input).
  // Explicit --output (-o) is trusted: the user intentionally chose the path,
  // and restricting it to cwd would break legitimate use (e.g. -o /tmp/file.png).
  if (!outputPath) {
    const normalizedSave = path.normalize(saveTo);
    if (!normalizedSave.startsWith(path.normalize(process.cwd()))) {
      throw new Error("Derived output path escapes current directory; please specify --output");
    }
  }

  const headers: Record<string, string> = {
    "access-token": apiKey,
  };

  if (debug) {
    const debugHeaders: Record<string, string> = { ...headers, "access-token": maskSecret(apiKey) };
    console.error(`Debug: Storage base URL: ${base}`);
    console.error(`Debug: GET URL: ${fullUrl}`);
    console.error(`Debug: Output: ${saveTo}`);
    console.error(`Debug: Request headers: ${JSON.stringify(debugHeaders)}`);
  }

  const response = await fetch(fullUrl, {
    method: "GET",
    headers,
  });

  if (debug) {
    console.error(`Debug: Response status: ${response.status}`);
    console.error(`Debug: Response headers: ${JSON.stringify(Object.fromEntries(response.headers.entries()))}`);
  }

  if (!response.ok) {
    const data = await response.text();
    throw new Error(formatHttpError("Failed to download file", response.status, data));
  }

  const contentLength = response.headers.get("content-length");
  if (contentLength && parseInt(contentLength, 10) > MAX_DOWNLOAD_SIZE) {
    throw new Error(`File too large: ${contentLength} bytes (max ${MAX_DOWNLOAD_SIZE})`);
  }

  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  // Create parent dirs for the output path. recursive:true is intentional —
  // the user may specify -o deeply/nested/path.png and expect it to work,
  // same as curl --create-dirs or wget -P.
  const parentDir = path.dirname(saveTo);
  if (!fs.existsSync(parentDir)) {
    fs.mkdirSync(parentDir, { recursive: true });
  }

  fs.writeFileSync(saveTo, buffer);

  return {
    savedTo: saveTo,
    size: buffer.length,
    mimeType: response.headers.get("content-type"),
  };
}

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp", ".ico"]);

/**
 * Build a markdown link for a file URL.
 * Returns `![name](url)` for images, `[name](url)` for other files.
 */
export function buildMarkdownLink(fileUrl: string, storageBaseUrl: string, filename?: string): string {
  const base = normalizeBaseUrl(storageBaseUrl);
  const normalizedFileUrl = fileUrl.startsWith("/") ? fileUrl : `/${fileUrl}`;
  const fullUrl = (fileUrl.startsWith("http://") || fileUrl.startsWith("https://")) ? fileUrl : `${base}${normalizedFileUrl}`;
  const name = filename || path.basename(new URL(fullUrl).pathname);
  const safeName = name.replace(/[\[\]()]/g, "\\$&");
  const ext = path.extname(name).toLowerCase();
  // fullUrl is not escaped — storage URLs are server-generated (UUID-based paths
  // like /files/641/1770646021425_019c42ba.png) and never contain parentheses.
  // Escaping would break the URL for renderers that don't decode %29 in href.
  if (IMAGE_EXTENSIONS.has(ext)) {
    return `![${safeName}](${fullUrl})`;
  }
  return `[${safeName}](${fullUrl})`;
}
