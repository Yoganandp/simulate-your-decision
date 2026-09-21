import { randomBytes, timingSafeEqual } from "node:crypto";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function createLocalAccess() {
  const token = randomBytes(32).toString("hex");
  return {
    token,
    authorize(req) {
      const host = req.headers.host;
      if (typeof host !== "string" || !/^[a-zA-Z0-9.:[\]-]+$/.test(host)) {
        return "A loopback Host header is required.";
      }
      let origin;
      try {
        const target = new URL(`http://${host}`);
        if (!LOOPBACK_HOSTS.has(target.hostname) || target.username || target.password) {
          return "This application only accepts loopback hosts.";
        }
        if (req.socket?.localPort && Number(target.port || 80) !== req.socket.localPort) {
          return "The Host port does not match this local server.";
        }
        origin = target.origin;
      } catch {
        return "Invalid Host header.";
      }
      if (req.headers.origin && req.headers.origin !== origin) {
        return "Cross-origin requests are not permitted.";
      }
      if (req.headers["sec-fetch-site"] === "cross-site") {
        return "Cross-site requests are not permitted.";
      }
      if (!SAFE_METHODS.has(req.method)) {
        const supplied = req.headers["x-simulation-token"];
        if (typeof supplied !== "string" || !/^[0-9a-f]{64}$/.test(supplied) ||
            !timingSafeEqual(Buffer.from(supplied), Buffer.from(token))) {
          return "Refresh the page to obtain a valid local session token.";
        }
        if (!/^application\/json(?:;|$)/i.test(req.headers["content-type"] || "")) {
          return "Write requests require application/json.";
        }
      }
      return null;
    },
  };
}

export function setLocalHeaders(res, { legacy = false } = {}) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Security-Policy", [
    "default-src 'self'",
    `script-src 'self'${legacy ? " 'unsafe-inline'" : ""}`,
    `style-src 'self'${legacy ? " 'unsafe-inline'" : ""}`,
    "img-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; "));
}
