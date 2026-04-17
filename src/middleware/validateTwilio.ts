// ─────────────────────────────────────────────────────────────────────────────
//  validateTwilio.ts — middleware to verify Twilio webhook signatures
//
//  Ensures only real Twilio requests reach our phone/SMS routes.
//  Skipped in local dev when BASE_URL is not set.
// ─────────────────────────────────────────────────────────────────────────────

import { Request, Response, NextFunction } from "express";
import twilio from "twilio";

export function validateTwilio(req: Request, res: Response, next: NextFunction): void {
  if (!process.env.BASE_URL || !process.env.TWILIO_AUTH_TOKEN) {
    next();
    return;
  }

  const signature = req.headers["x-twilio-signature"] as string | undefined;
  if (!signature) {
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
