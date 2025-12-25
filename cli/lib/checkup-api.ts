import * as https from "https";
import { URL } from "url";
import { normalizeBaseUrl } from "./util";

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
            let errMsg = `RPC ${rpcName} failed: HTTP ${res.statusCode}`;
            if (data) {
              try {
                const errObj = JSON.parse(data);
                errMsg += `\n${JSON.stringify(errObj, null, 2)}`;
              } catch {
                errMsg += `\n${data}`;
              }
            }
            reject(new Error(errMsg));
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


