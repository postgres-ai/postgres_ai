"use strict";

const http = require("http");
const { URL } = require("url");

/**
 * Start a local HTTP server to handle OAuth callback
 * @param {number} port - Port to listen on
 * @param {string} expectedState - Expected state parameter for CSRF protection
 * @param {number} timeoutMs - Timeout in milliseconds (default: 5 minutes)
 * @returns {Promise<Object>} Promise that resolves with { code, state } or rejects on error/timeout
 */
function startCallbackServer(port = 0, expectedState = null, timeoutMs = 300000) {
  return new Promise((resolve, reject) => {
    let resolved = false;
    let server = null;

    // Timeout handler
    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        if (server) {
          server.close();
        }
        reject(new Error("Authentication timeout. Please try again."));
      }
    }, timeoutMs);

    // Request handler
    const requestHandler = (req, res) => {
      if (resolved) {
        return;
      }

      // Only handle /callback path
      if (!req.url.startsWith("/callback")) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not Found");
        return;
      }

      try {
        const url = new URL(req.url, `http://localhost:${port}`);
        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state");
        const error = url.searchParams.get("error");
        const errorDescription = url.searchParams.get("error_description");

        // Handle OAuth error
        if (error) {
          resolved = true;
          clearTimeout(timeout);
          
          res.writeHead(400, { "Content-Type": "text/html" });
          res.end(`
<!DOCTYPE html>
<html>
<head>
  <title>Authentication Failed</title>
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; max-width: 600px; margin: 50px auto; padding: 20px; }
    .error { background: #fee; border: 1px solid #fcc; padding: 20px; border-radius: 8px; }
    h1 { color: #c33; margin-top: 0; }
    code { background: #f5f5f5; padding: 2px 6px; border-radius: 3px; }
  </style>
</head>
<body>
  <div class="error">
    <h1>Authentication Failed</h1>
    <p><strong>Error:</strong> ${escapeHtml(error)}</p>
    ${errorDescription ? `<p><strong>Description:</strong> ${escapeHtml(errorDescription)}</p>` : ""}
    <p>You can close this window and return to your terminal.</p>
  </div>
</body>
</html>
          `);
          
          server.close();
          reject(new Error(`OAuth error: ${error}${errorDescription ? ` - ${errorDescription}` : ""}`));
          return;
        }

        // Validate required parameters
        if (!code || !state) {
          res.writeHead(400, { "Content-Type": "text/html" });
          res.end(`
<!DOCTYPE html>
<html>
<head>
  <title>Authentication Failed</title>
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; max-width: 600px; margin: 50px auto; padding: 20px; }
    .error { background: #fee; border: 1px solid #fcc; padding: 20px; border-radius: 8px; }
    h1 { color: #c33; margin-top: 0; }
  </style>
</head>
<body>
  <div class="error">
    <h1>Authentication Failed</h1>
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
          
          res.writeHead(400, { "Content-Type": "text/html" });
          res.end(`
<!DOCTYPE html>
<html>
<head>
  <title>Authentication Failed</title>
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; max-width: 600px; margin: 50px auto; padding: 20px; }
    .error { background: #fee; border: 1px solid #fcc; padding: 20px; border-radius: 8px; }
    h1 { color: #c33; margin-top: 0; }
  </style>
</head>
<body>
  <div class="error">
    <h1>Authentication Failed</h1>
    <p>Invalid state parameter (possible CSRF attack).</p>
    <p>You can close this window and return to your terminal.</p>
  </div>
</body>
</html>
          `);
          
          server.close();
          reject(new Error("State mismatch (possible CSRF attack)"));
          return;
        }

        // Success!
        resolved = true;
        clearTimeout(timeout);
        
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(`
<!DOCTYPE html>
<html>
<head>
  <title>Authentication Successful</title>
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; max-width: 600px; margin: 50px auto; padding: 20px; }
    .success { background: #efe; border: 1px solid #cfc; padding: 20px; border-radius: 8px; }
    h1 { color: #3c3; margin-top: 0; }
  </style>
</head>
<body>
  <div class="success">
    <h1>Authentication Successful</h1>
    <p>You have successfully authenticated the PostgresAI CLI.</p>
    <p>You can close this window and return to your terminal.</p>
  </div>
</body>
</html>
        `);
        
        server.close();
        resolve({ code, state });
      } catch (err) {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          res.writeHead(500, { "Content-Type": "text/plain" });
          res.end("Internal Server Error");
          server.close();
          reject(err);
        }
      }
    };

    // Create and start server
    server = http.createServer(requestHandler);
    
    server.on("error", (err) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        reject(err);
      }
    });

    server.listen(port, "127.0.0.1", () => {
      // Don't resolve here, wait for callback
    });
  });
}

/**
 * Get the actual port the server is listening on
 * @param {http.Server} server - HTTP server instance
 * @returns {number} Port number
 */
function getServerPort(server) {
  const address = server.address();
  return address ? address.port : 0;
}

/**
 * Simple HTML escape utility
 * @param {string} str - String to escape
 * @returns {string} Escaped string
 */
function escapeHtml(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

module.exports = {
  startCallbackServer,
  getServerPort,
};

