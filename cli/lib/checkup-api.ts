import * as https from "https";
import { URL } from "url";
import { normalizeBaseUrl } from "./util";

export class RpcError extends Error {
  rpcName: string;
  statusCode: number;
  payloadText: string;
  payloadJson: any | null;

  constructor(params: { rpcName: string; statusCode: number; payloadText: string; payloadJson: any | null }) {
    const { rpcName, statusCode, payloadText, payloadJson } = params;
    super(`RPC ${rpcName} failed: HTTP ${statusCode}`);
    this.name = "RpcError";
    this.rpcName = rpcName;
    this.statusCode = statusCode;
    this.payloadText = payloadText;
    this.payloadJson = payloadJson;
  }
}

export function formatRpcErrorForDisplay(err: RpcError): string[] {
  const lines: string[] = [];
  lines.push(`Error: RPC ${err.rpcName} failed: HTTP ${err.statusCode}`);

  const obj = err.payloadJson && typeof err.payloadJson === "object" ? err.payloadJson : null;
  const details = obj && typeof (obj as any).details === "string" ? (obj as any).details : "";
  const hint = obj && typeof (obj as any).hint === "string" ? (obj as any).hint : "";
  const message = obj && typeof (obj as any).message === "string" ? (obj as any).message : "";

  if (message) lines.push(`Message: ${message}`);
  if (details) lines.push(`Details: ${details}`);
  if (hint) lines.push(`Hint: ${hint}`);

  // Fallback to raw payload if we couldn't extract anything useful.
  if (!message && !details && !hint) {
    const t = (err.payloadText || "").trim();
    if (t) lines.push(t);
  }
  return lines;
}

function unwrapRpcResponse(parsed: unknown): any {
  // Some deployments return a plain object, others return an array of rows,
  // and some wrap OUT params under a "result" key.
  if (Array.isArray(parsed)) {
    if (parsed.length === 1) return unwrapRpcResponse(parsed[0]);
    return parsed;
  }
  if (parsed && typeof parsed === "object") {
    const obj = parsed as any;
    if (obj.result !== undefined) return obj.result;
  }
  return parsed as any;
}

async function postRpc<T>(params: {
  apiKey: string;
  apiBaseUrl: string;
  rpcName: string;
  bodyObj: Record<string, unknown>;
}): Promise<T> {
  const { apiKey, apiBaseUrl, rpcName, bodyObj } = params;
  if (!apiKey) throw new Error("API key is required");
  const base = normalizeBaseUrl(apiBaseUrl);
  const url = new URL(`${base}/rpc/${rpcName}`);
  const body = JSON.stringify(bodyObj);

  const headers: Record<string, string> = {
    // The backend RPC functions accept access_token in body, but we also set the header
    // for compatibility with other endpoints and deployments.
    "access-token": apiKey,
    "Prefer": "return=representation",
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body).toString(),
  };

  return new Promise((resolve, reject) => {
    const req = https.request(
      url,
      {
        method: "POST",
        headers,
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            try {
              const parsed = JSON.parse(data);
              resolve(unwrapRpcResponse(parsed) as T);
            } catch {
              reject(new Error(`Failed to parse RPC response: ${data}`));
            }
          } else {
            const statusCode = res.statusCode || 0;
            let payloadJson: any | null = null;
            if (data) {
              try {
                payloadJson = JSON.parse(data);
              } catch {
                payloadJson = null;
              }
            }
            reject(new RpcError({ rpcName, statusCode, payloadText: data, payloadJson }));
          }
        });
      }
    );
    req.on("error", (err: Error) => reject(err));
    req.write(body);
    req.end();
  });
}

export async function createCheckupReport(params: {
  apiKey: string;
  apiBaseUrl: string;
  project: string;
  epoch: number;
  status?: string;
}): Promise<{ reportId: number }> {
  const { apiKey, apiBaseUrl, project, epoch, status } = params;
  const bodyObj: Record<string, unknown> = {
    access_token: apiKey,
    project,
    epoch,
  };
  if (status) bodyObj.status = status;

  const resp = await postRpc<any>({
    apiKey,
    apiBaseUrl,
    rpcName: "checkup_report_create",
    bodyObj,
  });
  const reportId = Number(resp?.report_id);
  if (!Number.isFinite(reportId) || reportId <= 0) {
    throw new Error(`Unexpected checkup_report_create response: ${JSON.stringify(resp)}`);
  }
  return { reportId };
}

export async function uploadCheckupReportJson(params: {
  apiKey: string;
  apiBaseUrl: string;
  reportId: number;
  filename: string;
  checkId: string;
  jsonText: string;
}): Promise<{ reportChunkId: number }> {
  const { apiKey, apiBaseUrl, reportId, filename, checkId, jsonText } = params;
  const bodyObj: Record<string, unknown> = {
    access_token: apiKey,
    checkup_report_id: reportId,
    filename,
    check_id: checkId,
    data: jsonText,
    type: "json",
    generate_issue: false,
  };

  const resp = await postRpc<any>({
    apiKey,
    apiBaseUrl,
    rpcName: "checkup_report_file_post",
    bodyObj,
  });
  const chunkId = Number(resp?.report_chunck_id ?? resp?.report_chunk_id);
  if (!Number.isFinite(chunkId) || chunkId <= 0) {
    throw new Error(`Unexpected checkup_report_file_post response: ${JSON.stringify(resp)}`);
  }
  return { reportChunkId: chunkId };
}


