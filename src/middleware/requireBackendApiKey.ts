// ─────────────────────────────────────────────────────────────────────────────
//  requireBackendApiKey.ts — middleware for Reed→backend service-to-service
//  calls. Round 26b (P-approved XX26b).
//
//  Production: requires X-Api-Key header matching BACKEND_API_KEY env var.
//  Comparison is timing-safe via crypto.timingSafeEqual.
//
//  Local-dev escape hatch (matches validateTwilio's pattern): if NODE_ENV is
//  not "production" and BACKEND_API_KEY is empty, skip the check with a
//  one-time warn. Production refuses to boot without the key (boot guard in
//  index.ts), so this fail-open path is unreachable in production.
// ─────────────────────────────────────────────────────────────────────────────

import { Request, Response, NextFunction } from "express";
import { timingSafeEqual } from "crypto";

const NODE_ENV = (process.env.NODE_ENV ?? "development").toLowerCase();
const IS_PRODUCTION = NODE_ENV === "production";
let warned = false;

export function requireBackendApiKey(req: Request, res: Response, next: NextFunction): void {
  const expected = process.env.BACKEND_API_KEY;

  if (!IS_PRODUCTION && !expected) {
    if (!warned) {
      warned = true;
      console.warn("[BackendApiKey] DEV MODE — auth skipped. Set BACKEND_API_KEY to enable.");
    }
    next();
    return;
  }
  if (!expected) {
    res.status(503).json({ error: "BACKEND_API_KEY not configured" });
    return;
  }
  const provided = String(req.headers["x-api-key"] || "");
  // timingSafeEqual requires equal-length Buffers; pre-check length first
  // to avoid a length-comparison side-channel.
  if (provided.length !== expected.length) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  let ok = false;
  try {
    ok = timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
  } catch {
    ok = false;
  }
  if (!ok) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  next();
}
