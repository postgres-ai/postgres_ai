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
 * Create and start callback server using Bun.serve
 * @param port - Port to listen on (0 for random available port)
 * @param expectedState - Expected state parameter for CSRF protection
 * @param timeoutMs - Timeout in milliseconds
 * @returns Server object with promise and getPort function
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
  let serverInstance: ReturnType<typeof Bun.serve> | null = null;

  const promise = new Promise<CallbackResult>((resolve, reject) => {
    resolveCallback = resolve;
    rejectCallback = reject;
  });

  // Timeout handler
  const timeout = setTimeout(() => {
    if (!resolved) {
      resolved = true;
      if (serverInstance) {
        serverInstance.stop();
      }
      rejectCallback(new Error("Authentication timeout. Please try again."));
    }
  }, timeoutMs);

  serverInstance = Bun.serve({
    port: port,
    hostname: "127.0.0.1",
    fetch(req) {
      if (resolved) {
        return new Response("Already handled", { status: 200 });
      }

      const url = new URL(req.url);

      // Only handle /callback path
      if (!url.pathname.startsWith("/callback")) {
        return new Response("Not Found", { status: 404 });
      }

      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      const error = url.searchParams.get("error");
      const errorDescription = url.searchParams.get("error_description");

      // Handle OAuth error
      if (error) {
        resolved = true;
        clearTimeout(timeout);

        setTimeout(() => serverInstance?.stop(), 100);
        rejectCallback(new Error(`OAuth error: ${error}${errorDescription ? ` - ${errorDescription}` : ""}`));

        return new Response(`
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
        `, { status: 400, headers: { "Content-Type": "text/html" } });
      }

      // Validate required parameters
      if (!code || !state) {
        return new Response(`
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
        `, { status: 400, headers: { "Content-Type": "text/html" } });
      }

      // Validate state (CSRF protection)
      if (expectedState && state !== expectedState) {
        resolved = true;
        clearTimeout(timeout);

        setTimeout(() => serverInstance?.stop(), 100);
        rejectCallback(new Error("State mismatch (possible CSRF attack)"));

        return new Response(`
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
        `, { status: 400, headers: { "Content-Type": "text/html" } });
      }

      // Success!
      resolved = true;
      clearTimeout(timeout);

      setTimeout(() => serverInstance?.stop(), 100);
      resolveCallback({ code, state });

      return new Response(`
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
      `, { status: 200, headers: { "Content-Type": "text/html" } });
    },
  });

  actualPort = serverInstance.port;

  return {
    server: { stop: () => serverInstance?.stop() },
    promise,
    getPort: () => actualPort,
  };
}

/**
 * Get the actual port the server is listening on
 * @param server - Bun server instance
 * @returns Port number
 */
export function getServerPort(server: ReturnType<typeof Bun.serve>): number {
  return server.port;
}
