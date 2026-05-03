// ─────────────────────────────────────────────────────────────────────────────
//  validateTwilio.ts — middleware to verify Twilio webhook signatures
//
//  Production behavior: signature is required. Missing or invalid → 403.
//  Local-dev behavior  (NODE_ENV !== "production" AND BASE_URL is empty):
//    skip validation so Twilio dev tunnels (ngrok etc.) work without
//    contortions. The boot guard in index.ts already refuses to start a
//    production process when BASE_URL is missing, so this fail-open path
//    cannot fire in prod.
// ─────────────────────────────────────────────────────────────────────────────

import { Request, Response, NextFunction } from "express";
import twilio from "twilio";

const NODE_ENV = (process.env.NODE_ENV ?? "development").toLowerCase();
const IS_PRODUCTION = NODE_ENV === "production";

// Log once per process so misconfiguration is visible in startup logs.
let loggedDevSkip = false;
let loggedProdNoToken = false;

export function validateTwilio(req: Request, res: Response, next: NextFunction): void {
  // Local dev bypass: only when explicitly NOT in production AND BASE_URL is
  // empty. Production with empty BASE_URL was already rejected at boot in
  // index.ts; this branch is unreachable there.
  if (!IS_PRODUCTION && (!process.env.BASE_URL || !process.env.TWILIO_AUTH_TOKEN)) {
    if (!loggedDevSkip) {
      loggedDevSkip = true;
      console.warn(
        "[Twilio] Local-dev mode: signature validation is SKIPPED for all " +
        "/api/phone and /api/sms routes. Set BASE_URL + TWILIO_AUTH_TOKEN to " +
        "enable validation."
      );
    }
    next();
    return;
  }

  if (!process.env.TWILIO_AUTH_TOKEN) {
    if (!loggedProdNoToken) {
      loggedProdNoToken = true;
      console.error(
        "[Twilio] PRODUCTION misconfiguration: TWILIO_AUTH_TOKEN is empty " +
        "but BASE_URL is set. Refusing all Twilio webhook traffic until token " +
        "is configured."
      );
    }
    res.status(503).send("Twilio auth not configured");
    return;
  }

  const signature = req.headers["x-twilio-signature"] as string | undefined;
  if (!signature) {
    console.warn(`[Twilio] Missing x-twilio-signature header on ${req.originalUrl}`);
    res.status(403).send("Forbidden");
    return;
  }

  const url = `${process.env.BASE_URL}${req.originalUrl}`;
  const params = req.body as Record<string, string>;

  const valid = twilio.validateRequest(
    process.env.TWILIO_AUTH_TOKEN,
    signature,
    url,
    params
  );

  if (!valid) {
    console.warn(`[Twilio] Signature validation failed for ${req.originalUrl}`);
    res.status(403).send("Forbidden");
    return;
  }

  next();
}
