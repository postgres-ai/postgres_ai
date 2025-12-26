import * as http from "http";

/**
 * OAuth callback result
 */
export interface CallbackResult {
  code: string;
  state: string;
}

/**
 * Callback server structure
 */
export interface CallbackServer {
  server: { stop: () => void };
  promise: Promise<CallbackResult>;
  ready: Promise<number>; // Resolves with actual port when server is listening
  getPort: () => number;
}

/**
 * Simple HTML escape utility
 * @param str - String to escape
 * @returns Escaped string
 */
function escapeHtml(str: string | null): string {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Create and start callback server using Node.js http module
 *
 * @param port - Port to listen on (0 for random available port)
 * @param expectedState - Expected state parameter for CSRF protection
 * @param timeoutMs - Timeout in milliseconds
 * @returns Server object with promise, ready promise, and getPort function
 *
 * @remarks
 * The `ready` promise resolves with the actual port once the server is listening.
 * Callers should await `ready` before using `getPort()` when using port 0.
 *
 * The server stops asynchronously ~100ms after the callback resolves/rejects.
 * This delay ensures the HTTP response is fully sent before closing the connection.
 * Callers should not attempt to reuse the same port immediately after the promise
 * resolves - wait at least 200ms or use a different port.
 */
export function createCallbackServer(
  port: number = 0,
  expectedState: string | null = null,
  timeoutMs: number = 300000
): CallbackServer {
  let resolved = false;
  let actualPort = port;
  let resolveCallback: (value: CallbackResult) => void;
  let rejectCallback: (reason: Error) => void;
  let resolveReady: (port: number) => void;
  let rejectReady: (reason: Error) => void;
  let serverInstance: http.Server | null = null;

  const promise = new Promise<CallbackResult>((resolve, reject) => {
    resolveCallback = resolve;
    rejectCallback = reject;
  });

  const ready = new Promise<number>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });

  const stopServer = () => {
    if (serverInstance) {
      serverInstance.close();
      serverInstance = null;
    }
  };

  // Timeout handler
  const timeout = setTimeout(() => {
    if (!resolved) {
      resolved = true;
      stopServer();
      rejectCallback(new Error("Authentication timeout. Please try again."));
    }
  }, timeoutMs);

  serverInstance = http.createServer((req, res) => {
    if (resolved) {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("Already handled");
      return;
    }

    const url = new URL(req.url || "/", `http://127.0.0.1:${actualPort}`);

    // Only handle /callback path
    if (!url.pathname.startsWith("/callback")) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not Found");
      return;
    }

    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const error = url.searchParams.get("error");
    const errorDescription = url.searchParams.get("error_description");

    // Handle OAuth error
    if (error) {
      resolved = true;
      clearTimeout(timeout);

      setTimeout(() => stopServer(), 100);
      rejectCallback(new Error(`OAuth error: ${error}${errorDescription ? ` - ${errorDescription}` : ""}`));

      res.writeHead(400, { "Content-Type": "text/html" });
      res.end(`
<!DOCTYPE html>
<html>
<head>
  <title>Authentication failed</title>
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; max-width: 600px; margin: 50px auto; padding: 20px; }
    .error { background: #fee; border: 1px solid #fcc; padding: 20px; border-radius: 8px; }
    h1 { color: #c33; margin-top: 0; }
    code { background: #f5f5f5; padding: 2px 6px; border-radius: 3px; }
  </style>
</head>
<body>
  <div class="error">
    <h1>Authentication failed</h1>
    <p><strong>Error:</strong> ${escapeHtml(error)}</p>
    ${errorDescription ? `<p><strong>Description:</strong> ${escapeHtml(errorDescription)}</p>` : ""}
    <p>You can close this window and return to your terminal.</p>
  </div>
</body>
</html>
      `);
      return;
    }

    // Validate required parameters
    if (!code || !state) {
      res.writeHead(400, { "Content-Type": "text/html" });
      res.end(`
<!DOCTYPE html>
<html>
<head>
  <title>Authentication failed</title>
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; max-width: 600px; margin: 50px auto; padding: 20px; }
    .error { background: #fee; border: 1px solid #fcc; padding: 20px; border-radius: 8px; }
    h1 { color: #c33; margin-top: 0; }
  </style>
</head>
<body>
  <div class="error">
    <h1>Authentication failed</h1>
    <p>Missing required parameters (code or state).</p>
    <p>You can close this window and return to your terminal.</p>
  </div>
</body>
</html>
      `);
      return;
    }

    // Validate state (CSRF protection)
    if (expectedState && state !== expectedState) {
      resolved = true;
      clearTimeout(timeout);

      setTimeout(() => stopServer(), 100);
      rejectCallback(new Error("State mismatch (possible CSRF attack)"));

      res.writeHead(400, { "Content-Type": "text/html" });
      res.end(`
<!DOCTYPE html>
<html>
<head>
  <title>Authentication failed</title>
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; max-width: 600px; margin: 50px auto; padding: 20px; }
    .error { background: #fee; border: 1px solid #fcc; padding: 20px; border-radius: 8px; }
    h1 { color: #c33; margin-top: 0; }
  </style>
</head>
<body>
  <div class="error">
    <h1>Authentication failed</h1>
    <p>Invalid state parameter (possible CSRF attack).</p>
    <p>You can close this window and return to your terminal.</p>
  </div>
</body>
</html>
      `);
      return;
    }

    // Success!
    resolved = true;
    clearTimeout(timeout);

    // Resolve first, then stop server asynchronously after response is sent.
    // The 100ms delay ensures the HTTP response is fully written before closing.
    resolveCallback({ code, state });
    setTimeout(() => stopServer(), 100);

    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(`
<!DOCTYPE html>
<html>
<head>
  <title>Authentication successful</title>
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; max-width: 600px; margin: 50px auto; padding: 20px; }
    .success { background: #efe; border: 1px solid #cfc; padding: 20px; border-radius: 8px; }
    h1 { color: #3c3; margin-top: 0; }
  </style>
</head>
<body>
  <div class="success">
    <h1>Authentication successful</h1>
    <p>You have successfully authenticated the PostgresAI CLI.</p>
    <p>You can close this window and return to your terminal.</p>
  </div>
</body>
</html>
    `);
  });

  // Handle server errors (e.g., EADDRINUSE)
  serverInstance.on("error", (err: NodeJS.ErrnoException) => {
    clearTimeout(timeout);
    if (err.code === "EADDRINUSE") {
      rejectReady(new Error(`Port ${port} is already in use`));
    } else {
      rejectReady(new Error(`Server error: ${err.message}`));
    }
    if (!resolved) {
      resolved = true;
      rejectCallback(err);
    }
  });

  serverInstance.listen(port, "127.0.0.1", () => {
    const address = serverInstance?.address();
    if (address && typeof address === "object") {
      actualPort = address.port;
    }
    resolveReady(actualPort);
  });

  return {
    server: { stop: stopServer },
    promise,
    ready,
    getPort: () => actualPort,
  };
}
