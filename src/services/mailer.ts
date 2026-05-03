// ─────────────────────────────────────────────────────────────────────────────
//  mailer.ts — SMTP wrapper for outbound auto-sent enforcement emails
//
//  Used by the pressure-stack auto-fire path to send class-action firm
//  referrals, carrier abuse complaints, and registrar abuse complaints
//  on Marcus's behalf when AUTO_SEND_PRESSURE=true.
//
//  CONFIG (env):
//    SMTP_HOST       - e.g. smtp.gmail.com (Gmail), smtp.sendgrid.net (SG), etc.
//    SMTP_PORT       - 587 for STARTTLS (most common), 465 for SSL/TLS
//    SMTP_USER       - the SMTP username (often the From address)
//    SMTP_PASS       - the SMTP password OR Gmail "app password" (NOT regular pw)
//    SMTP_FROM       - the From: header — e.g. "Marcus DeScant <marcus@example.com>"
//    SMTP_REPLY_TO   - optional Reply-To override; defaults to SMTP_FROM
//    AUTO_SEND_PRESSURE - "true" to actually fire emails on isNewlyActionable
//                         (without this, mailer logs only — no actual sends)
//
//  GRACEFUL FAILURE MODE:
//    If SMTP_HOST/USER/PASS are not all set: every send() call returns a
//    "skipped" result with reason — never throws. The auto-fire orchestrator
//    treats this the same as "I would have sent X but no SMTP configured."
//
//  RATE LIMITING:
//    Built-in in-memory limit: max 30 outbound sends per hour per process.
//    Prevents an unexpected actionable-case storm from burning through a
//    Gmail daily quota or triggering deliverability flags.
// ─────────────────────────────────────────────────────────────────────────────

import * as nodemailer from "nodemailer";

let _transport: nodemailer.Transporter | null = null;

function smtpConfigured(): boolean {
  return !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

function getTransport(): nodemailer.Transporter | null {
  if (_transport) return _transport;
  if (!smtpConfigured()) return null;
  const port = parseInt(process.env.SMTP_PORT ?? "587", 10);
  _transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure: port === 465, // SSL/TLS for 465; STARTTLS otherwise
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    pool: true,
    maxConnections: 3,
    maxMessages: 50,
  });
  return _transport;
}

export interface SendMailParams {
  to: string;
  subject: string;
  body: string;
  /** Optional CC list (always BCC's the user's own SMTP_FROM as audit trail). */
  cc?: string[];
  /** Optional Reply-To override; defaults to SMTP_REPLY_TO env or SMTP_FROM. */
  replyTo?: string;
}

export type SendMailResult =
  | { sent: true; messageId: string; recipient: string }
  | { sent: false; reason: "skipped"; detail: string }
  | { sent: false; reason: "rate-limited"; detail: string }
  | { sent: false; reason: "error"; detail: string };

// ── Rate-limit bookkeeping ────────────────────────────────────────────────
const RATE_LIMIT_PER_HOUR = 30;
const sendTimestamps: number[] = [];

function checkRateLimit(): { ok: boolean; reason?: string } {
  const now = Date.now();
  // Drop timestamps older than 1 hour
  const cutoff = now - 60 * 60 * 1000;
  while (sendTimestamps.length > 0 && sendTimestamps[0] < cutoff) sendTimestamps.shift();
  if (sendTimestamps.length >= RATE_LIMIT_PER_HOUR) {
    return { ok: false, reason: `rate limit: ${RATE_LIMIT_PER_HOUR} sends/hour exceeded` };
  }
  return { ok: true };
}

// ── Public API ────────────────────────────────────────────────────────────

/**
 * Send an email via configured SMTP. Never throws.
 *
 * Auto-send gate: this function ONLY actually sends if AUTO_SEND_PRESSURE
 * env var is set to "true". Without that, the function returns
 * { sent: false, reason: "skipped" } even if SMTP is configured. This is
 * a safety belt — Marcus must explicitly opt into auto-sending.
 */
export async function sendMail(p: SendMailParams): Promise<SendMailResult> {
  const autoOn = (process.env.AUTO_SEND_PRESSURE ?? "false").toLowerCase() === "true";
  if (!autoOn) {
    return {
      sent: false,
      reason: "skipped",
      detail: "AUTO_SEND_PRESSURE is not 'true' — emails are dry-run only. Set AUTO_SEND_PRESSURE=true in .env to enable.",
    };
  }
  if (!smtpConfigured()) {
    return {
      sent: false,
      reason: "skipped",
      detail: "SMTP not configured (SMTP_HOST / SMTP_USER / SMTP_PASS missing in .env).",
    };
  }
  const rate = checkRateLimit();
  if (!rate.ok) {
    return { sent: false, reason: "rate-limited", detail: rate.reason ?? "rate limited" };
  }

  const transport = getTransport();
  if (!transport) {
    return { sent: false, reason: "skipped", detail: "transport unavailable" };
  }

  const from = process.env.SMTP_FROM ?? process.env.SMTP_USER!;
  const replyTo = p.replyTo ?? process.env.SMTP_REPLY_TO ?? from;
  // Always BCC the user themselves as an audit trail.
  const auditBcc = process.env.SMTP_FROM ?? process.env.SMTP_USER!;

  try {
    const info = await transport.sendMail({
      from,
      to: p.to,
      cc: p.cc,
      bcc: auditBcc,
      replyTo,
      subject: p.subject,
      text: p.body,
    });
    sendTimestamps.push(Date.now());
    console.log(`[Mailer] sent to ${p.to} (subject: "${p.subject.slice(0, 60)}") messageId=${info.messageId}`);
    return { sent: true, messageId: info.messageId, recipient: p.to };
  } catch (err) {
    const msg = (err as Error)?.message ?? String(err);
    console.warn(`[Mailer] send failed to ${p.to}: ${msg}`);
    return { sent: false, reason: "error", detail: msg };
  }
}

/** Diagnostic helper for /api/health and dashboard. */
export function mailerStatus(): {
  configured: boolean;
  autoSendEnabled: boolean;
  recentSends: number;
  rateLimitPerHour: number;
} {
  // Drop stale timestamps before reporting
  const cutoff = Date.now() - 60 * 60 * 1000;
  while (sendTimestamps.length > 0 && sendTimestamps[0] < cutoff) sendTimestamps.shift();
  return {
    configured: smtpConfigured(),
    autoSendEnabled: (process.env.AUTO_SEND_PRESSURE ?? "false").toLowerCase() === "true",
    recentSends: sendTimestamps.length,
    rateLimitPerHour: RATE_LIMIT_PER_HOUR,
  };
}
