import * as https from "https";
import { URL } from "url";
import { maskSecret, normalizeBaseUrl } from "./util";

export interface FetchIssuesParams {
  apiKey: string;
  apiBaseUrl: string;
  debug?: boolean;
}

export async function fetchIssues(params: FetchIssuesParams): Promise<unknown> {
  const { apiKey, apiBaseUrl, debug } = params;
  if (!apiKey) {
    throw new Error("API key is required");
  }

  const base = normalizeBaseUrl(apiBaseUrl);
  const url = new URL(`${base}/issues`);

  const headers: Record<string, string> = {
    "access-token": apiKey,
    "Prefer": "return=representation",
    "Content-Type": "application/json",
  };

  if (debug) {
    const debugHeaders: Record<string, string> = { ...headers, "access-token": maskSecret(apiKey) };
    // eslint-disable-next-line no-console
    console.log(`Debug: Resolved API base URL: ${base}`);
    // eslint-disable-next-line no-console
    console.log(`Debug: GET URL: ${url.toString()}`);
    // eslint-disable-next-line no-console
    console.log(`Debug: Auth scheme: access-token`);
    // eslint-disable-next-line no-console
    console.log(`Debug: Request headers: ${JSON.stringify(debugHeaders)}`);
  }

  return new Promise((resolve, reject) => {
    const req = https.request(
      url,
      {
        method: "GET",
        headers,
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          if (debug) {
            // eslint-disable-next-line no-console
            console.log(`Debug: Response status: ${res.statusCode}`);
            // eslint-disable-next-line no-console
            console.log(`Debug: Response headers: ${JSON.stringify(res.headers)}`);
          }
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            try {
              const parsed = JSON.parse(data);
              resolve(parsed);
            } catch {
              resolve(data);
            }
          } else {
            let errMsg = `Failed to fetch issues: HTTP ${res.statusCode}`;
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
    req.end();
  });
}


