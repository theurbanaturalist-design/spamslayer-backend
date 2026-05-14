// ─────────────────────────────────────────────────────────────────────────────
//  requireDashboardAuth.ts — HTTP Basic auth for admin/dashboard endpoints.
//  Round 26b (P-approved XX26b).
//
//  Production: requires Basic auth with DASHBOARD_USER + DASHBOARD_PASSWORD
//  env vars. BOTH username and password are compared timing-safe (P-required
//  delta: don't use === for the username). Decoded Basic-auth payload must
//  contain a `:` separator (P-required delta: reject malformed headers).
//
//  Local-dev escape hatch (matches validateTwilio's pattern): if NODE_ENV is
//  not "production" and DASHBOARD_PASSWORD is empty, skip with a one-time warn.
//  Production refuses to boot without the password (boot guard in index.ts).
// ─────────────────────────────────────────────────────────────────────────────

import { Request, Response, NextFunction } from "express";
import { timingSafeEqual } from "crypto";

const NODE_ENV = (process.env.NODE_ENV ?? "development").toLowerCase();
const IS_PRODUCTION = NODE_ENV === "production";
let warned = false;

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a), Buffer.from(b));
  } catch {
    return false;
  }
}

export function requireDashboardAuth(req: Request, res: Response, next: NextFunction): void {
  const expectedUser = process.env.DASHBOARD_USER;
  const expectedPass = process.env.DASHBOARD_PASSWORD;
  const backendKey = process.env.BACKEND_API_KEY;

  // Round 26b: bypass for valid service-to-service X-Api-Key. The Tier B
  // routes (POST /cases/log, GET /cases/check, etc.) register requireBackend-
  // ApiKey before this middleware fires, but Express' app.use bulk-mount on
  // /api/cases still runs for those paths. Skipping here when a valid key
  // is present means Tier B requests pass cleanly. If the key doesn't
  // match, fall through to the Basic-auth check below — requireBackend-
  // ApiKey would have already rejected the request before reaching here.
  if (backendKey) {
    const provided = String(req.headers["x-api-key"] || "");
    if (provided.length === backendKey.length) {
      try {
        if (timingSafeEqual(Buffer.from(provided), Buffer.from(backendKey))) {
          next();
          return;
        }
      } catch { /* fall through */ }
    }
  }

  if (!IS_PRODUCTION && !expectedPass) {
    if (!warned) {
      warned = true;
      console.warn("[DashboardAuth] DEV MODE — auth skipped. Set DASHBOARD_USER + DASHBOARD_PASSWORD to enable.");
    }
    next();
    return;
  }
  if (!expectedUser || !expectedPass) {
    res.status(503).send("Dashboard auth not configured");
    return;
  }

  const header = String(req.headers["authorization"] || "");
  const [scheme, encoded] = header.split(" ");
  if (scheme !== "Basic" || !encoded) {
    res.setHeader("WWW-Authenticate", 'Basic realm="SpamSlayer Admin"');
    res.status(401).send("Unauthorized");
    return;
  }

  let decoded = "";
  try {
    decoded = Buffer.from(encoded, "base64").toString("utf-8");
  } catch {
    decoded = "";
  }
  const colon = decoded.indexOf(":");
  // P-required delta CC26b#2: reject malformed payloads with no separator.
  if (colon < 0) {
    res.setHeader("WWW-Authenticate", 'Basic realm="SpamSlayer Admin"');
    res.status(401).send("Unauthorized");
    return;
  }
  const user = decoded.slice(0, colon);
  const pass = decoded.slice(colon + 1);

  // P-required delta CC26b#1: timing-safe compare for the username too.
  const userOk = safeEqual(user, expectedUser);
  const passOk = safeEqual(pass, expectedPass);
  if (!userOk || !passOk) {
    res.setHeader("WWW-Authenticate", 'Basic realm="SpamSlayer Admin"');
    res.status(401).send("Unauthorized");
    return;
  }
  next();
}
