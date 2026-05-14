// ─────────────────────────────────────────────────────────────────────────────
//  SpamSlayer — TCPA Compliance Bot
//
//  An employee that answers spam calls, engages the caller to extract their
//  company info, records everything, builds legal cases, and texts users
//  when they have an actionable TCPA lawsuit.
//
//  Routes:
//    /api/phone/*     Twilio voice webhooks (spam calls)
//    /api/sms/*       Twilio SMS webhooks (user signup & commands)
//    /api/cases/*     Case data API (for dashboard/frontend)
//    /api/health      Health check
// ─────────────────────────────────────────────────────────────────────────────

import dotenv from "dotenv";
import path from "path";

dotenv.config({ path: path.resolve(__dirname, "../.env"), override: true });

// Sanity checks
console.log("[SpamSlayer] GOOGLE_API_KEY:", process.env.GOOGLE_API_KEY ? "defined" : "MISSING");
console.log("[SpamSlayer] TWILIO_ACCOUNT_SID:", process.env.TWILIO_ACCOUNT_SID ? "defined" : "MISSING");
console.log("[SpamSlayer] TWILIO_PHONE_NUMBER:", process.env.TWILIO_PHONE_NUMBER ?? "(not set)");

import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import { validateTwilio } from "./middleware/validateTwilio";
import { requireBackendApiKey } from "./middleware/requireBackendApiKey";
import { requireDashboardAuth } from "./middleware/requireDashboardAuth";
import phoneRouter from "./routes/phone";
import smsRouter from "./routes/signup";
import * as CaseBuilder from "./services/caseBuilder";
import * as UserManager from "./services/userManager";
import { gradeConversation, type ConversationTurn } from "./services/conversationGrader";
import * as Discord from "./services/discordNotifier";
import { lookupLineType } from "./services/twilioLookupClient";
import { lookupEntity } from "./services/openCorporatesClient";
import { lookupPriorLitigation } from "./services/courtListenerClient";
import { researchTcpaDefendant } from "./services/sonarClient";
// researchEntityIdentity is exported from sonarClient for future use (e.g.,
// a manual "drill into this defendant" button on the dashboard) but isn't
// called from the per-actionable-case orchestration today — the broader
// researchTcpaDefendant briefing already covers entity identity in its
// first paragraph.
import { buildEvidenceChecklist, buildCaseStagesGuide } from "./services/evidenceChecklist";
import { decideFiling } from "./services/filingDecision";
import { buildPressureStack, detectCampaigns, autoFirePressureStack, autoFireUnlockedItems } from "./services/pressureStack";
import { evaluateCaseStrength } from "./services/caseStrengthMeter";
import { scoreCollectability } from "./services/defendantResearch";
import { generateFilingPackage } from "./services/legalFilingGenerator";
import { runMonitor, triggerRenderRedeploy, BOTS_TO_MONITOR } from "./services/healthMonitor";

const app = express();
const PORT = parseInt(process.env.PORT ?? "3003", 10);

// ── Production-readiness boot guard ─────────────────────────────────────────
// In production, the Twilio signature validator depends on BASE_URL being set.
// If it's not set, validateTwilio.ts fails OPEN (skips signature checks), which
// would let anyone POST fake spam calls. Refuse to boot rather than ship with
// authentication silently disabled. Local dev (NODE_ENV !== "production") is
// allowed to skip — that's how Twilio dev tunnels work.
const NODE_ENV = (process.env.NODE_ENV ?? "development").toLowerCase();
if (NODE_ENV === "production" && !process.env.BASE_URL) {
  console.error(
    "[SpamSlayer] FATAL: NODE_ENV=production but BASE_URL is empty. " +
    "Twilio webhook signature validation requires BASE_URL to be set to your " +
    "public URL (e.g. https://spamslayer.onrender.com). Refusing to boot with " +
    "authentication disabled. Set BASE_URL in your environment and retry."
  );
  process.exit(78); // sysexits(3) EX_CONFIG
}

// Round 26b (P-approved XX26b): refuse to boot in production without backend
// API key + dashboard credentials. Same fail-loud-not-open pattern as the
// BASE_URL guard above. Per P's SS26b refinement, DASHBOARD_USER must be
// explicitly set (no silent "marcus" default in production).
if (NODE_ENV === "production") {
  const missing: string[] = [];
  if (!process.env.BACKEND_API_KEY) missing.push("BACKEND_API_KEY");
  if (!process.env.DASHBOARD_USER) missing.push("DASHBOARD_USER");
  if (!process.env.DASHBOARD_PASSWORD) missing.push("DASHBOARD_PASSWORD");
  if (missing.length > 0) {
    console.error(
      `[SpamSlayer] FATAL: NODE_ENV=production but these env vars are missing: ${missing.join(", ")}. ` +
      "Round 26b requires these for backend API-key auth and dashboard Basic auth. " +
      "Refusing to boot with authentication disabled."
    );
    process.exit(78);
  }
}

// ── CORS allowlist (Audit Round 15 B3) ──────────────────────────────────────
// Plain app.use(cors()) lets any origin POST to our routes — including
// /api/cases/log, which would let an attacker forge call entries into the
// case database. Restrict to an env-driven allowlist; default permits only
// the local Vite dev server. To allow your real frontend in production, set:
//   SPAMSLAYER_ALLOWED_ORIGINS=https://app.example.com,https://www.example.com
const allowedOriginsRaw = (process.env.SPAMSLAYER_ALLOWED_ORIGINS ?? "http://localhost:5173").trim();
const ALLOWED_ORIGINS = allowedOriginsRaw.split(",").map((s) => s.trim()).filter(Boolean);

app.use(cors({
  origin: (origin, cb) => {
    // No Origin header = server-to-server (curl, Twilio, internal cron). Allow.
    // The validateTwilio middleware separately verifies Twilio webhook auth.
    if (!origin) return cb(null, true);
    if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    return cb(new Error(`[CORS] origin ${origin} not in SPAMSLAYER_ALLOWED_ORIGINS allowlist`));
  },
  credentials: true,
  methods: ["GET", "POST", "OPTIONS"],
  maxAge: 600,
}));

// 256 KB body cap; Twilio webhooks are tiny (form-encoded), JSON cases/log
// payloads are bounded by transcript length. A bigger cap would let a hostile
// poster pump arbitrary data into cases.json.
app.use(express.urlencoded({ extended: false, limit: "256kb" })); // Twilio sends form-encoded
app.use(express.json({ limit: "256kb" }));

// Round 26b (P-approved TT26b): generous rate limits — bound abuse without
// biting normal traffic. Reed at 300/min for call-end + Layer 2 traffic;
// dashboard at 120/min for one-user browsing + inline XHRs; public at 60/min
// for health checks.
const reedLimiter = rateLimit({ windowMs: 60_000, max: 300, standardHeaders: true, legacyHeaders: false });
const dashboardLimiter = rateLimit({ windowMs: 60_000, max: 120, standardHeaders: true, legacyHeaders: false });
const publicLimiter = rateLimit({ windowMs: 60_000, max: 60, standardHeaders: true, legacyHeaders: false });

// ── Twilio webhook routes (signature-validated) ──────────────────────────
app.use("/api/phone", validateTwilio, phoneRouter);
app.use("/api/sms", validateTwilio, smsRouter);

// Round 26b Tier B (P-approved UU26b): Reed→backend service-to-service
// calls. MUST be defined BEFORE the Tier C bulk mount below — Express picks
// the first matching handler, and bulk-mounted requireDashboardAuth would
// otherwise trap Reed's outbound calls.
//
// The handler bodies for these four endpoints stay where they are later in
// the file. These middlewares apply globally to any future definition of
// the same method+path because Express runs route-level middleware in
// registration order. To make the order explicit AND keep handlers near
// their helpers, we wrap each Tier B route via app.use() with a path-prefix
// matcher that fires *only* the limiter + key-check for those specific
// path+method combinations.
app.post("/api/cases/log",              reedLimiter, requireBackendApiKey, (_req, _res, next) => next());
app.post("/api/cases/set-recording",    reedLimiter, requireBackendApiKey, (_req, _res, next) => next());
app.get ("/api/cases/check",            reedLimiter, requireBackendApiKey, (_req, _res, next) => next());
app.get ("/api/cases/offender/:number", reedLimiter, requireBackendApiKey, (_req, _res, next) => next());

// Round 26b Tier C (P-approved UU26b): bulk-mount auth+rate-limit for every
// other admin/dashboard/cases/users surface. Mounted AFTER Tier B so the
// Tier B middlewares + the actual handlers later in the file fire first
// for those specific paths.
app.use(
  ["/api/cases", "/api/admin", "/api/dashboard", "/api/users", "/api/recordings", "/dashboard"],
  dashboardLimiter,
  requireDashboardAuth,
);

// ── Public API routes (for frontend dashboard) ───────────────────────────

app.get("/api/health", (_req, res) => {
  res.json({
    status: "ok",
    service: "SpamSlayer",
    timestamp: new Date().toISOString(),
    users: UserManager.getUserCount(),
  });
});

// Round 26.0 (P-approved P26 / V260): compat alias for external health checks
// that hit the bare /health path instead of /api/health. Body is intentionally
// minimal — monitors only check the 200 status code.
app.get("/health", (_req, res) => res.json({ status: "ok" }));

// ─────────────────────────────────────────────────────────────────────────────
// Evidence-checklist helpers + endpoints
// ─────────────────────────────────────────────────────────────────────────────

import * as fs_ from "fs";
import * as path_2 from "path";

/** Read phone.json defensively so checklist generation works even when
 *  Marcus hasn't fully filled in his info. Missing fields use safe
 *  placeholders that the user will replace when they actually file. */
function loadUserContextForChecklist(): {
  userName: string; userPhone: string; userAddress: string;
  userEmail: string; userState: string; userStateLong: string; courtName?: string;
} {
  const candidates = [
    path_2.resolve(__dirname, "..", "..", "..", "phone.json"),
    path_2.resolve(process.cwd(), "phone.json"),
    path_2.resolve(process.cwd(), "..", "phone.json"),
  ];
  let cfg: any = null;
  for (const p of candidates) {
    if (fs_.existsSync(p)) {
      try { cfg = JSON.parse(fs_.readFileSync(p, "utf-8")); break; }
      catch { /* try next */ }
    }
  }
  const fc = cfg?.filingConfig ?? {};
  const stateMap: Record<string, string> = {
    LA: "Louisiana", TX: "Texas", CA: "California", FL: "Florida",
    NY: "New York", GA: "Georgia", IL: "Illinois", AL: "Alabama",
    MS: "Mississippi", AR: "Arkansas",
  };
  const state = (fc.userState ?? "LA").toUpperCase();
  return {
    userName: fc.userName ?? "[YOUR NAME — fill in phone.json]",
    userPhone: fc.userPhone ?? "+1XXXXXXXXXX",
    userAddress: fc.userAddress ?? "[YOUR ADDRESS — fill in phone.json]",
    userEmail: fc.userEmail ?? "[YOUR EMAIL]",
    userState: state,
    userStateLong: stateMap[state] ?? state,
    courtName: fc.courtName,
  };
}

// GET /api/cases/:number/checklist — fetch current checklist (auto-build if missing)
app.get("/api/cases/:number/checklist", (req, res) => {
  const num = CaseBuilder.normalizePhone(req.params.number);
  const offender = CaseBuilder.getOffender(num);
  if (!offender) { res.status(404).json({ error: "offender not found" }); return; }
  if (!offender.actionable) { res.status(400).json({ error: "case not actionable yet (need 2+ calls in 12mo)" }); return; }
  if (!offender.evidenceChecklist) {
    try {
      const ctx = loadUserContextForChecklist();
      const checklist = buildEvidenceChecklist(offender, ctx);
      CaseBuilder.attachEvidenceChecklist(num, checklist);
      res.json(checklist);
      return;
    } catch (err) {
      res.status(500).json({ error: `failed to build checklist: ${(err as Error).message}` });
      return;
    }
  }
  res.json(offender.evidenceChecklist);
});

// POST /api/cases/:number/checklist/:itemId/toggle — mark item complete/incomplete
app.post("/api/cases/:number/checklist/:itemId/toggle", (req, res) => {
  const num = CaseBuilder.normalizePhone(req.params.number);
  const itemId = req.params.itemId;
  const force = typeof req.body?.completed === "boolean" ? req.body.completed : undefined;
  const result = CaseBuilder.toggleChecklistItem(num, itemId, force);
  if (!result.found) { res.status(404).json({ error: "checklist item not found" }); return; }
  res.json({ ok: true, completed: result.completed });
});

// POST /api/admin/health-now — run the full monitor pass on demand.
// Returns the structured snapshot + any state transitions that fired.
app.post("/api/admin/health-now", async (_req, res) => {
  try {
    const result = await runMonitor();
    // Discord-ping any transitions that fired
    for (const t of result.transitions) {
      const ctx = [{ name: "Alarm", value: t.alarmId }];
      Discord.notifyAlarm({
        alarmId: t.alarmId,
        transitionTo: t.to,
        message: t.message,
        durationMs: t.durationMs,
        context: ctx,
      }).catch((err) => console.warn("[HealthMonitor] Discord notify failed:", err?.message));
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/admin/auto-restart-bot — manually trigger a Render redeploy of
// a bot's service. Use this when monitor flags a silent-failure pattern and
// you want to try the easy fix (restart) before digging into Reed's code.
app.post("/api/admin/auto-restart-bot", async (req, res) => {
  const slug = req.body?.slug;
  if (!slug) { res.status(400).json({ error: "slug required" }); return; }
  const bot = BOTS_TO_MONITOR.find((b) => b.slug === slug);
  if (!bot) { res.status(404).json({ error: `unknown bot: ${slug}` }); return; }
  const r = await triggerRenderRedeploy(bot.renderServiceId);
  if (r.ok) {
    Discord.notifyAlarm({
      alarmId: `manual-restart:${slug}`,
      transitionTo: "ok",  // optimistic — restart kicked off
      message: `Manual Render redeploy triggered for ${slug} (deploy ${r.deployId}). Monitor will verify recovery on next pass.`,
    }).catch(() => undefined);
  }
  res.json(r);
});

// POST /api/admin/test-smtp — sends a one-off test email to SMTP_FROM
// Use this AFTER configuring a new dedicated SMTP account to confirm
// credentials work before relying on auto-fire. Bypasses the
// AUTO_SEND_PRESSURE gate (it's an explicit admin action, not auto-fire).
app.post("/api/admin/test-smtp", async (_req, res) => {
  // Minimal local sender that bypasses the AUTO_SEND_PRESSURE gate so the
  // user can test credentials BEFORE flipping the auto-send switch.
  const from = process.env.SMTP_FROM ?? process.env.SMTP_USER;
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS || !from) {
    res.status(400).json({
      ok: false,
      error: "SMTP not fully configured. Need SMTP_HOST, SMTP_USER, SMTP_PASS, and SMTP_FROM in .env.",
    });
    return;
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const nodemailer = require("nodemailer") as typeof import("nodemailer");
    const port = parseInt(process.env.SMTP_PORT ?? "587", 10);
    const transport = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port,
      secure: port === 465,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
    const info = await transport.sendMail({
      from,
      to: from, // send to self — self-test only
      subject: "✅ SpamSlayer SMTP test — credentials work",
      text:
        `If you're reading this in the inbox of ${from}, your dedicated SpamSlayer email account is wired up correctly.\n\n` +
        `What this means:\n` +
        `  • Outbound emails from SpamSlayer auto-fire (USTelecom, class-action firms, carrier abuse, registrar abuse) will use this account.\n` +
        `  • Each outbound also BCCs this address, so you'll have a copy of every send in this inbox.\n` +
        `  • If anyone replies to the auto-fired emails, the reply will land at: ${process.env.SMTP_REPLY_TO ?? from}\n\n` +
        `Sent at: ${new Date().toISOString()}\n\nSpamSlayer admin self-test.`,
    });
    res.json({
      ok: true,
      messageId: info.messageId,
      recipient: from,
      message: "Test email sent. Check the inbox of " + from + " — should arrive within ~30s.",
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: (err as Error).message,
      hint: "Common causes: wrong app-password (must be 16 chars, no spaces), wrong SMTP_HOST/PORT, 2FA not enabled on the Gmail account, account locked by Google after first send (check security alerts).",
    });
  }
});

// GET /api/cases/:number/pressure-stack — non-judgment enforcement enumerator
app.get("/api/cases/:number/pressure-stack", (req, res) => {
  const num = CaseBuilder.normalizePhone(req.params.number);
  const offender = CaseBuilder.getOffender(num);
  if (!offender) { res.status(404).json({ error: "offender not found" }); return; }
  try {
    const stack = buildPressureStack(offender, loadUserContextForChecklist());
    res.json(stack);
  } catch (err) {
    res.status(500).json({ error: `pressure stack failed: ${(err as Error).message}` });
  }
});

// POST /api/cases/:number/pressure-stack/auto-fire — manual trigger
// Force-runs autoFirePressureStack for the case. Handy for one-off
// retries OR when AUTO_SEND_PRESSURE was off when the case became actionable.
// Honors the same SMTP gate — if AUTO_SEND_PRESSURE !== "true", every
// item returns reason="skipped" with a clear message.
app.post("/api/cases/:number/pressure-stack/auto-fire", async (req, res) => {
  const num = CaseBuilder.normalizePhone(req.params.number);
  const offender = CaseBuilder.getOffender(num);
  if (!offender) { res.status(404).json({ error: "offender not found" }); return; }
  const force = req.body?.force === true;
  try {
    const userCtx = loadUserContextForChecklist();
    const results = await autoFirePressureStack(offender, userCtx, { force });
    if (results.length > 0) {
      Discord.notifyAutoFire({
        callerPhone: offender.normalizedNumber,
        companyName: offender.companyName,
        results: results.map((r) => ({
          title: r.title,
          recipient: r.recipient,
          sent: r.result.sent,
          detail: r.result.sent ? `messageId: ${r.result.messageId}` : `${r.result.reason}: ${r.result.detail}`,
        })),
      }).catch(() => undefined);
    }
    res.json({ ok: true, results });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/dashboard/patterns — coordinated-campaign detection across cases
app.get("/api/dashboard/patterns", (_req, res) => {
  try {
    const all = CaseBuilder.getAllOffenders();
    const patterns = detectCampaigns(all);
    res.json({ generatedAt: new Date().toISOString(), patterns });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/cases/:number/should-file — single GO / WAIT / DON'T FILE verdict
// Combines case strength + collectability + evidence completeness + EV math.
app.get("/api/cases/:number/should-file", (req, res) => {
  const num = CaseBuilder.normalizePhone(req.params.number);
  const offender = CaseBuilder.getOffender(num);
  if (!offender) { res.status(404).json({ error: "offender not found" }); return; }
  if (!offender.actionable) { res.status(400).json({ error: "case not actionable yet (need 2+ calls in 12mo)" }); return; }
  try {
    const decision = decideFiling(offender);
    res.json(decision);
  } catch (err) {
    res.status(500).json({ error: `decision failed: ${(err as Error).message}` });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/cases/:number/case-file
//
// One-shot "everything we know about this caller" payload that powers the
// Case File drawer in the dashboard. Combines:
//   - Full offender profile (calls, recordings, transcripts, identity)
//   - Case strength meter (10-factor breakdown, 0-100)
//   - Collectability scorecard (per-signal breakdown, 0-100)
//   - Filing decision (GO / WAIT / DON'T FILE + EV math)
//   - Evidence checklist progress
//   - Pressure stack
//   - Defendant research (Sonar summary, OpenCorporates, CourtListener)
//   - Filing-readiness composite score 0-100 (the "how close to suing" meter)
//   - Draft petition preview (live-generated; falls back to placeholder text
//     if phone.json isn't filled in)
//
// Designed so the dashboard can show the entire case file in one drawer
// without N round-trips.
// ─────────────────────────────────────────────────────────────────────────────
app.get("/api/cases/:number/case-file", (req, res) => {
  const num = CaseBuilder.normalizePhone(req.params.number);
  const offender = CaseBuilder.getOffender(num);
  if (!offender) {
    res.status(404).json({ error: "offender not found" });
    return;
  }

  // Case strength (always available, even pre-actionable)
  let strength: ReturnType<typeof evaluateCaseStrength> = null;
  try { strength = evaluateCaseStrength(num); } catch (err) {
    console.warn(`[case-file] strength failed for ${num}:`, (err as Error).message);
  }

  // Collectability — pull cached enrichment off the offender so we don't make
  // network calls inside the dashboard request path.
  let collect: ReturnType<typeof scoreCollectability> | null = null;
  try {
    const enrichment: any = {};
    if (offender.lineTypeLookup?.normalizedType) {
      enrichment.lineType = {
        type: offender.lineTypeLookup.normalizedType,
        carrier: offender.lineTypeLookup.carrierName ?? undefined,
        countryCode: offender.lineTypeLookup.countryCode ?? undefined,
      };
    }
    if (offender.priorLitigation?.status === "match" && typeof offender.priorLitigation.caseCount === "number") {
      enrichment.priorLitigationCount = offender.priorLitigation.caseCount;
    } else if (offender.priorLitigation?.status === "no_match") {
      enrichment.priorLitigationCount = 0;
    }
    if (offender.entityLookup) {
      const e = offender.entityLookup;
      if (e.status === "match" && e.matchedName && e.normalizedStatus) {
        enrichment.entity = {
          status: "match",
          matchedName: e.matchedName,
          companyNumber: e.companyNumber,
          jurisdictionCode: e.jurisdictionCode ?? undefined,
          normalizedStatus: e.normalizedStatus,
          rawStatus: e.rawStatus ?? null,
          incorporationDate: e.incorporationDate ?? null,
          registeredAddress: e.registeredAddress ?? null,
          sourceUrl: e.sourceUrl,
          lookedUpAt: e.lookedUpAt,
          matchConfidence: e.matchConfidence,
        };
      } else if (e.status === "no_match") {
        enrichment.entity = { status: "no_match", lookedUpAt: e.lookedUpAt };
      }
    }
    collect = scoreCollectability(offender, { enrichment: Object.keys(enrichment).length > 0 ? enrichment : undefined });
  } catch (err) {
    console.warn(`[case-file] collectability failed for ${num}:`, (err as Error).message);
  }

  // Filing decision — only meaningful for actionable cases
  let decision = null;
  if (offender.actionable) {
    try { decision = decideFiling(offender); } catch (err) {
      console.warn(`[case-file] decision failed for ${num}:`, (err as Error).message);
    }
  }

  // Evidence checklist — auto-build on first read for actionable cases
  let checklist = offender.evidenceChecklist ?? null;
  if (!checklist && offender.actionable) {
    try {
      const ctx = loadUserContextForChecklist();
      checklist = buildEvidenceChecklist(offender, ctx);
      CaseBuilder.attachEvidenceChecklist(num, checklist);
    } catch (err) {
      console.warn(`[case-file] checklist build failed for ${num}:`, (err as Error).message);
    }
  }

  // Pressure stack
  let pressureStack = null;
  try { pressureStack = buildPressureStack(offender, loadUserContextForChecklist()); } catch (err) {
    console.warn(`[case-file] pressure-stack failed for ${num}:`, (err as Error).message);
  }

  // Draft petition preview — call the real generator. If phone.json isn't
  // filled in (validateFilingConfig throws) or the case isn't ready, fall
  // back to a placeholder string with the diagnostic.
  let petitionPreview: { available: boolean; text: string; caseRef?: string; warnings?: string[]; reason?: string } =
    { available: false, text: "", reason: "Petition not yet drafted." };
  if (offender.actionable) {
    try {
      const pkg = generateFilingPackage(num);
      if (pkg) {
        petitionPreview = {
          available: true,
          text: pkg.petition,
          caseRef: pkg.caseNumber,
          warnings: pkg.warnings,
        };
      } else {
        petitionPreview = {
          available: false,
          text: "",
          reason: "Filing generator declined to produce a draft (case not actionable, all calls past SOL, or self-suit guard tripped). See server logs for details.",
        };
      }
    } catch (err) {
      petitionPreview = {
        available: false,
        text: "",
        reason: `Petition generator threw: ${(err as Error).message}. Most commonly this means phone.json is missing required filing-config fields.`,
      };
    }
  } else {
    petitionPreview = {
      available: false,
      text: "",
      reason: `Case is not yet actionable. The TCPA private right of action requires 2+ calls within 12 months — this caller has ${offender.callCount}. The petition will become available the moment the threshold is crossed.`,
    };
  }

  // ── Filing-readiness composite score ───────────────────────────────────
  // 0-100 indicator of how close the case is to being file-ready.
  //   30% case strength
  //   30% collectability (50 if not yet known)
  //   30% evidence checklist completeness
  //   10% defendant identified (binary)
  //
  // Round 26.0b (P-approved BB260b): defendant-ID is a HARD filing
  // prerequisite — you can't sue a defendant you can't name. Without it
  // the composite would otherwise look "almost ready" while missing the
  // condition that actually blocks filing. Cap the composite at 80 when
  // defendant-ID is missing so the bar visibly stalls until you have a
  // name. The cap is intentionally above "obviously not ready" but below
  // "ready to file" so it reads as a yellow/amber state in the UI.
  const evidencePct = checklist && checklist.items.length > 0
    ? Math.round((checklist.items.filter((i) => i.completed).length / checklist.items.length) * 100)
    : 0;
  const collectScore = collect?.score ?? 50;
  const strengthScore = strength?.score ?? 0;
  const defendantId = offender.companyName ? 100 : 0;
  const rawReadiness = Math.round(
    (strengthScore * 0.30) + (collectScore * 0.30) + (evidencePct * 0.30) + (defendantId * 0.10)
  );
  // P-approved BB260b: hard gate at 80 when defendant is unidentified.
  const filingReadinessPct = defendantId === 0 ? Math.min(rawReadiness, 80) : rawReadiness;

  // ── Per-case statute coverage — count citations the petition will use
  // and how many are in the verified registry. Cheap heuristic by scanning
  // the verified citation registry and matching by simple substring on the
  // petition text. If the petition didn't generate, fall back to global.
  let statuteCoverage: { citedTotal: number; citedVerified: number; citedUnverified: number } | null = null;
  if (petitionPreview.available && petitionPreview.text) {
    let cited = 0, verified = 0;
    for (const e of (require("./services/statuteRegistry").CITATION_REGISTRY as any[])) {
      const needle = e.citationText ?? e.label ?? e.id;
      if (needle && petitionPreview.text.includes(needle)) {
        cited++;
        if (e.verification?.status === "verified") verified++;
      }
    }
    statuteCoverage = { citedTotal: cited, citedVerified: verified, citedUnverified: cited - verified };
  }

  res.json({
    generatedAt: new Date().toISOString(),
    offender,
    strength,
    collectability: collect,
    decision,
    checklist,
    pressureStack,
    petitionPreview,
    filingReadinessPct,
    filingReadinessBreakdown: {
      caseStrengthPct: strengthScore,
      collectabilityPct: collectScore,
      evidencePct,
      defendantIdentified: !!offender.companyName,
    },
    statuteCoverage,
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/recordings/:callSid
//
// Audio proxy so the dashboard can play recordings inline. Twilio recording
// URLs require HTTP basic auth (account SID + auth token), which we obviously
// can't expose to the browser. This route looks the recording up by callSid,
// fetches it server-side with the right credentials, and streams the audio
// back. The browser sees a plain audio file it can put in <audio src="...">.
//
// Range-aware so the audio scrubber works (browsers do partial-content GETs
// when seeking).
//
// Security: only callSids we already have in our cases.json get proxied —
// no SSRF surface for arbitrary URLs.
// ─────────────────────────────────────────────────────────────────────────────
app.get("/api/recordings/:callSid", async (req, res) => {
  const callSid = String(req.params.callSid || "").trim();
  if (!callSid) { res.status(400).json({ error: "callSid required" }); return; }

  // Find the recording URL for this callSid by scanning known offenders
  const offenders = CaseBuilder.getAllOffenders();
  let recordingUrl: string | null = null;
  for (const o of offenders) {
    for (const c of o.calls ?? []) {
      if (c.callSid === callSid && c.recordingUrl) {
        recordingUrl = c.recordingUrl;
        break;
      }
    }
    if (recordingUrl) break;
  }
  if (!recordingUrl) {
    res.status(404).json({ error: "no recording found for that callSid" });
    return;
  }

  // Twilio recording URLs from the API don't include .mp3 — appending it
  // tells Twilio to serve audio rather than the JSON metadata wrapper.
  let upstream = recordingUrl;
  const isTwilio = /api\.twilio\.com/i.test(upstream);
  if (isTwilio && !/\.(mp3|wav)$/i.test(upstream)) upstream = upstream + ".mp3";

  // Round 26.0b (P-approved CC260b): upstream-host allowlist in ADDITION
  // to the stored-URL SSRF guard above. Even though cases.json should
  // only ever contain Twilio recording URLs, defense-in-depth: parse the
  // URL and refuse to proxy any host not on the allowlist. Prevents a
  // future bug or data-migration mishap that lands a non-Twilio URL in
  // cases.json from turning this endpoint into an open proxy.
  const RECORDING_HOST_ALLOWLIST = new Set([
    "api.twilio.com",
  ]);
  let upstreamHost = "";
  try { upstreamHost = new URL(upstream).hostname.toLowerCase(); } catch { upstreamHost = ""; }
  if (!upstreamHost || !RECORDING_HOST_ALLOWLIST.has(upstreamHost)) {
    console.warn(`[recordings] host-allowlist deny callSid=${callSid} host=${upstreamHost || "?"}`);
    res.status(400).json({ error: "recording URL host not on allowlist" });
    return;
  }

  const headers: Record<string, string> = {};
  // Forward Range requests so audio scrubbing works
  if (req.headers.range) headers["Range"] = String(req.headers.range);

  // Auth — only when going to Twilio. For arbitrary URLs (test fixtures,
  // S3 links, etc.) we pass through unauthenticated.
  if (isTwilio) {
    const sid = process.env.TWILIO_ACCOUNT_SID;
    const token = process.env.TWILIO_AUTH_TOKEN;
    if (!sid || !token) {
      res.status(500).json({ error: "Twilio recording URL but TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN not configured on the server" });
      return;
    }
    headers["Authorization"] = "Basic " + Buffer.from(`${sid}:${token}`).toString("base64");
  }

  try {
    const upstreamResp = await fetch(upstream, { headers });
    // Mirror status (200 OK or 206 Partial Content) and useful headers
    res.status(upstreamResp.status);
    const passThrough = ["content-type", "content-length", "content-range", "accept-ranges", "cache-control", "etag"];
    for (const h of passThrough) {
      const v = upstreamResp.headers.get(h);
      if (v) res.setHeader(h, v);
    }
    if (!upstreamResp.headers.get("content-type")) {
      res.setHeader("Content-Type", "audio/mpeg");  // sane default for Twilio .mp3
    }
    // Stream the body
    if (!upstreamResp.body) { res.end(); return; }
    const reader = upstreamResp.body.getReader();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) res.write(Buffer.from(value));
    }
    res.end();
  } catch (err) {
    console.warn(`[recordings] proxy failed for ${callSid}:`, (err as Error).message);
    res.status(502).json({ error: `upstream fetch failed: ${(err as Error).message}` });
  }
});

// POST /api/cases/:number/flag-test  body: { isTest: boolean }
// Manually mark an offender as test data (or unmark). Test offenders are
// hidden from headline metrics, get a TEST badge in the UI, and skip Sonar
// research on subsequent calls.
app.post("/api/cases/:number/flag-test", (req, res) => {
  const num = CaseBuilder.normalizePhone(req.params.number);
  const isTest = req.body?.isTest === true;
  const ok = CaseBuilder.setOffenderTestFlag(num, isTest);
  if (!ok) { res.status(404).json({ error: "offender not found" }); return; }
  res.json({ ok: true, normalizedNumber: num, isTest });
});

// DELETE /api/cases/:number — permanently remove an offender (typically used
// to clean up after test seeding).
app.delete("/api/cases/:number", (req, res) => {
  const num = CaseBuilder.normalizePhone(req.params.number);
  const ok = CaseBuilder.deleteOffender(num);
  if (!ok) { res.status(404).json({ error: "offender not found" }); return; }
  res.json({ ok: true, normalizedNumber: num });
});

// POST /api/cases/:number/checklist/regenerate — rebuild checklist (e.g., after editing phone.json)
app.post("/api/cases/:number/checklist/regenerate", (req, res) => {
  const num = CaseBuilder.normalizePhone(req.params.number);
  const offender = CaseBuilder.getOffender(num);
  if (!offender) { res.status(404).json({ error: "offender not found" }); return; }
  try {
    const ctx = loadUserContextForChecklist();
    const checklist = buildEvidenceChecklist(offender, ctx);
    CaseBuilder.attachEvidenceChecklist(num, checklist);
    res.json({ ok: true, items: checklist.items.length });
  } catch (err) {
    res.status(500).json({ error: `regen failed: ${(err as Error).message}` });
  }
});

// Standalone single-page dashboard (no build step). Lives at backend/public/dashboard.html.
app.get("/dashboard", (_req, res) => {
  const dashPath = require("path").resolve(__dirname, "..", "public", "dashboard.html");
  if (!fs_.existsSync(dashPath)) {
    res.status(404).send("dashboard.html not found at " + dashPath);
    return;
  }
  res.type("html").send(fs_.readFileSync(dashPath, "utf-8"));
});

// Case summary for a specific user
app.get("/api/cases/summary/:userId", (req, res) => {
  const summary = CaseBuilder.getCaseSummary(req.params.userId);
  res.json(summary);
});

// All actionable cases for a user
app.get("/api/cases/actionable/:userId", (req, res) => {
  const cases = CaseBuilder.getActionableCases(req.params.userId);
  res.json(cases);
});

// All offenders (admin view)
app.get("/api/cases/all", (_req, res) => {
  const offenders = CaseBuilder.getAllOffenders();
  res.json(offenders);
});

// All offenders — flat list used by Reed admin panel's spam cases table
app.get("/api/cases", (_req, res) => {
  const offenders = CaseBuilder.getAllOffenders();
  res.json(offenders.map((o) => ({
    companyName: o.companyName,
    callerName: o.callerNames[0] || null,
    callerPhone: o.normalizedNumber,
    callCount: o.callCount,
    isActionable: o.actionable,
    damagesEstimate: o.damagesEstimate,
  })));
});

// Check if a number is a known offender — used by Reed to route calls
app.get("/api/cases/check", (req, res) => {
  const phone = (req.query.phone as string) || "";
  if (!phone) { res.status(400).json({ error: "phone required" }); return; }
  const offender = CaseBuilder.getOffender(CaseBuilder.normalizePhone(phone));
  res.json({ known: !!offender, callCount: offender?.callCount ?? 0 });
});

// Single offender detail
app.get("/api/cases/offender/:number", (req, res) => {
  const offender = CaseBuilder.getOffender(CaseBuilder.normalizePhone(req.params.number));
  if (!offender) {
    res.status(404).json({ error: "Offender not found" });
    return;
  }
  res.json(offender);
});

// Generate demand letter
app.post("/api/cases/demand-letter", (req, res) => {
  const { number, userName, userAddress, userPhone, dncSince } = req.body;
  const letter = CaseBuilder.generateDemandLetter(
    CaseBuilder.normalizePhone(number),
    userName,
    userAddress,
    userPhone,
    dncSince
  );
  if (!letter) {
    res.status(400).json({ error: "Cannot generate letter — case not actionable or offender not found" });
    return;
  }
  CaseBuilder.markDemandSent(CaseBuilder.normalizePhone(number));
  res.json({ letter });
});

// Log a spam call received by Reed's native intercept.
// Reed POSTs here after each spam call ends so SpamSlayer can build the case.
app.post("/api/cases/log", (req, res) => {
  const {
    callSid, callerPhone, subscriberId,
    extractedCompany, extractedCallerName, extractedPurpose,
    turns, isTest,
  } = req.body as {
    callSid?: string;
    callerPhone?: string;
    subscriberId?: string;
    extractedCompany?: string;
    extractedCallerName?: string;
    extractedPurpose?: string;
    turns?: Array<{ role: string; text: string }>;
    isTest?: boolean;
  };

  if (!callerPhone) {
    res.status(400).json({ error: "callerPhone required" });
    return;
  }

  const snippet = (turns ?? [])
    .map((t) => `${t.role === "caller" ? "Caller" : "Bot"}: ${t.text}`)
    .join(" | ")
    .slice(0, 300);

  const { offender, isNewlyActionable, isTest: offenderIsTest } = CaseBuilder.logCall(
    subscriberId ?? "unknown",
    callerPhone,
    extractedCompany ?? null,
    extractedCallerName ?? null,
    extractedPurpose ?? null,
    callSid ?? "unknown",
    null,
    snippet,
    "telemarketing",
    { isTest: isTest === true }
  );

  // ── Grade the conversation and persist the verdict on the CallEntry ────
  const normalizedTurns: ConversationTurn[] = (turns ?? [])
    .map((t) => ({
      role: t.role === "caller" ? "caller" : "bot",
      text: typeof t.text === "string" ? t.text : "",
    }));

  const grade = gradeConversation({
    callSid: callSid ?? "unknown",
    companyName: extractedCompany ?? null,
    callerName: extractedCallerName ?? null,
    purpose: extractedPurpose ?? null,
    recordingUrl: null,  // recording is backfilled separately; grade runs at log-time
    turns: normalizedTurns,
  });

  if (callSid) {
    CaseBuilder.attachGrade(callSid, {
      letter: grade.grade,
      score: grade.score,
      hangUpRisk: grade.hangUpRisk,
      missingInfo: grade.missingInfo,
      summary: grade.summary,
    });
  }

  console.log(
    `[API] /cases/log — caller=${callerPhone} company=${extractedCompany ?? "?"} ` +
    `callCount=${offender.callCount} actionable=${offender.actionable} newlyActionable=${isNewlyActionable} ` +
    `grade=${grade.grade}/${grade.score} hangUp=${grade.hangUpRisk}` +
    (offenderIsTest ? " TEST" : "")
  );

  // ── Test data: short-circuit ALL paid-API research (Twilio Lookup,
  //    OpenCorporates, CourtListener, Sonar). No point burning real credits
  //    on synthetic offenders, and the dashboard will hide them from the
  //    headline metrics anyway.
  if (offenderIsTest) {
    res.json({
      ok: true,
      callCount: offender.callCount,
      actionable: offender.actionable,
      isNewlyActionable,
      isTest: true,
      damagesEstimate: offender.damagesEstimate,
      grade: { letter: grade.grade, score: grade.score, hangUpRisk: grade.hangUpRisk, missingInfo: grade.missingInfo },
    });
    return;
  }

  // ── Sonar identification on FIRST call for real callers ──────────────
  //    Per Marcus: "i have lots of credit, half a cent is fine to see who's
  //    calling". Was previously gated on isNewlyActionable (call #2), which
  //    meant a single-time caller never got identified. Now fires on call #1
  //    too — still cached + 30-day TTL'd so the cost ceiling holds.
  //    Skipped if: no company name extracted yet (Sonar can't research a
  //    blank name), no PERPLEXITY_API_KEY, or already cached fresh.
  if (offender.companyName && offender.callCount === 1 && !offenderIsTest) {
    const needSonarFirst = !offender.defendantWebResearch
      || !CaseBuilder.isFreshLookup(offender.defendantWebResearch.lookedUpAt, 30);
    if (needSonarFirst) {
      const company = offender.companyName;
      const numberKey = offender.normalizedNumber;
      researchTcpaDefendant(company)
        .then((r) => {
          const lookedUpAt = ("lookedUpAt" in r && r.lookedUpAt) ? r.lookedUpAt : new Date().toISOString();
          if (r.status === "match") {
            CaseBuilder.attachDefendantWebResearch(numberKey, {
              status: "match", summary: r.summary, citations: r.citations, model: r.model, lookedUpAt,
            });
            console.log(`[Research:firstCall] Sonar (${r.model}) match for "${company}" — ${r.summary.length} chars, ${r.citations.length} citations, $${r.costUsd.toFixed(4)}`);
          } else if (r.status === "error") {
            CaseBuilder.attachDefendantWebResearch(numberKey, { status: "error", errorMessage: r.errorMessage, lookedUpAt });
          } else {
            CaseBuilder.attachDefendantWebResearch(numberKey, { status: "skipped", errorMessage: r.reason, lookedUpAt });
          }
        })
        .catch((err) => console.warn(`[Research:firstCall] Sonar threw for "${company}":`, err?.message ?? err));
    }
  }

  // ── P3.1: kick off Twilio Lookup so the legal filing generator picks
  //          the right TCPA prong. Fire-and-forget; never blocks the response.
  //          attachLineTypeLookup is idempotent + 90-day-cached so this
  //          costs at most $0.005 per spam number per quarter.
  if (offender.callCount === 1) {
    lookupLineType(offender.normalizedNumber)
      .then((r) => {
        if (r.status !== "match") return;
        CaseBuilder.attachLineTypeLookup(offender.normalizedNumber, {
          normalizedType: r.normalizedType,
          rawType: r.rawType,
          carrierName: r.carrierName,
          countryCode: r.countryCode,
          lookedUpAt: r.lookedUpAt,
        });
      })
      .catch((err) => console.warn(`[LineLookup] failed for ${offender.normalizedNumber}:`, err?.message ?? err));
  }

  // ── AUDIT_ROUND_19: when the offender becomes actionable (call #2), fire
  //    OpenCorporates + CourtListener research in parallel. Both APIs are
  //    free / generous-tier and gracefully no-op when name is missing or
  //    network fails. Cached on OffenderProfile so generateFilingPackage
  //    can read them back synchronously when building the petition.
  //    Cost-bounded: only fires on isNewlyActionable (~once per case).
  if (isNewlyActionable && offender.companyName) {
    const company = offender.companyName;
    const numberKey = offender.normalizedNumber;

    // Re-fetch only if cache stale — cheap defensive check
    const needEntity = !offender.entityLookup || !CaseBuilder.isFreshLookup(offender.entityLookup.lookedUpAt, 90);
    const needLitigation = !offender.priorLitigation || !CaseBuilder.isFreshLookup(offender.priorLitigation.lookedUpAt, 30);

    if (needEntity) {
      // OpenCorporates is OPT-IN. Their 2026 pricing tier shifted to ~$240/mo
      // entry which doesn't fit a personal/legal-aid use case, and the free
      // tier requires open-license publication of the data. We call OC only
      // when the user has explicitly opted in via OPENCORPORATES_API_KEY.
      // Otherwise we mark the slot as "skipped" so the dashboard shows
      // n/a (not pending) — the broader Sonar TCPA briefing below already
      // covers entity identity (registered name, jurisdiction, registered
      // agent) for ~$0.005, so no enrichment value is lost.
      if (process.env.OPENCORPORATES_API_KEY) {
        lookupEntity(company)
          .then((r) => {
            const lookedUpAt = ("lookedUpAt" in r && r.lookedUpAt) ? r.lookedUpAt : new Date().toISOString();
            if (r.status === "match") {
              CaseBuilder.attachEntityLookup(numberKey, {
                status: "match",
                matchedName: r.matchedName,
                companyNumber: r.companyNumber,
                jurisdictionCode: r.jurisdictionCode ?? null,
                normalizedStatus: r.normalizedStatus,
                rawStatus: r.rawStatus,
                incorporationDate: r.incorporationDate,
                registeredAddress: r.registeredAddress,
                sourceUrl: r.sourceUrl,
                matchConfidence: r.matchConfidence,
                lookedUpAt,
              });
              console.log(`[Research] OpenCorporates match for "${company}": ${r.matchedName} (${r.normalizedStatus})`);
            } else if (r.status === "no_match") {
              CaseBuilder.attachEntityLookup(numberKey, { status: "no_match", lookedUpAt });
            } else if (r.status === "error") {
              CaseBuilder.attachEntityLookup(numberKey, { status: "error", errorMessage: r.errorMessage, lookedUpAt });
              console.warn(`[Research] OpenCorporates error for "${company}": ${r.errorMessage}`);
            } else {
              CaseBuilder.attachEntityLookup(numberKey, { status: "skipped", lookedUpAt });
            }
          })
          .catch((err) => console.warn(`[Research] OpenCorporates threw for "${company}":`, err?.message ?? err));
      } else {
        // Mark explicitly skipped so dashboard renders "n/a" not "pending"
        CaseBuilder.attachEntityLookup(numberKey, {
          status: "skipped",
          errorMessage: "OPENCORPORATES_API_KEY not set; entity identity covered by Sonar briefing instead.",
          lookedUpAt: new Date().toISOString(),
        });
      }
    }

    if (needLitigation) {
      lookupPriorLitigation(company)
        .then((r) => {
          const lookedUpAt = ("lookedUpAt" in r && r.lookedUpAt) ? r.lookedUpAt : new Date().toISOString();
          if (r.status === "match") {
            CaseBuilder.attachPriorLitigation(numberKey, {
              status: "match",
              caseCount: r.caseCount,
              sampleCases: r.sampleCases?.slice(0, 5),
              searchUrl: r.searchUrl,
              lookedUpAt,
            });
            console.log(`[Research] CourtListener match for "${company}": ${r.caseCount} federal case(s)`);
          } else if (r.status === "no_match") {
            CaseBuilder.attachPriorLitigation(numberKey, { status: "no_match", caseCount: 0, searchUrl: r.searchUrl, lookedUpAt });
            console.log(`[Research] CourtListener no_match for "${company}"`);
          } else if (r.status === "error") {
            CaseBuilder.attachPriorLitigation(numberKey, { status: "error", errorMessage: r.errorMessage, lookedUpAt });
            console.warn(`[Research] CourtListener error for "${company}": ${r.errorMessage}`);
          } else {
            CaseBuilder.attachPriorLitigation(numberKey, { status: "skipped", lookedUpAt });
          }
        })
        .catch((err) => console.warn(`[Research] CourtListener threw for "${company}":`, err?.message ?? err));
    }

    // ── AUDIT_ROUND_20: build per-case evidence checklist + stages guide ──
    //    Generated once on isNewlyActionable. Pulls user context from
    //    phone.json with safe defaults if fields aren't filled in yet.
    if (!offender.evidenceChecklist) {
      try {
        const userCtx = loadUserContextForChecklist();
        const checklist = buildEvidenceChecklist(offender, userCtx);
        CaseBuilder.attachEvidenceChecklist(numberKey, checklist);
        console.log(`[Checklist] Generated ${checklist.items.length} evidence items for ${numberKey}`);
      } catch (err) {
        console.warn(`[Checklist] Failed to build for ${numberKey}:`, (err as Error).message);
      }
    }

    // ── AUDIT_ROUND_23: auto-fire pressure stack ──────────────────────────
    //    When AUTO_SEND_PRESSURE=true and SMTP is configured, immediately
    //    send the auto-capable items (USTelecom escalation + class-action
    //    firm referral). Items gated on later signals (ITG carrier ID,
    //    Sonar website) fire from the background pump when the prereq
    //    arrives. Posts a Discord audit embed of what got sent.
    setImmediate(async () => {
      try {
        const userCtx = loadUserContextForChecklist();
        const refreshedOffender = CaseBuilder.getOffender(numberKey);
        if (!refreshedOffender) return;
        const fireResults = await autoFirePressureStack(refreshedOffender, userCtx);
        if (fireResults.length > 0) {
          fireResults.forEach((r) =>
            console.log(`[AutoFire] ${r.itemId}: ${r.result.sent ? "SENT" : "skip/error"} → ${r.recipient} (${"detail" in r.result ? r.result.detail : "ok"})`)
          );
          await Discord.notifyAutoFire({
            callerPhone: refreshedOffender.normalizedNumber,
            companyName: refreshedOffender.companyName,
            results: fireResults.map((r) => ({
              title: r.title,
              recipient: r.recipient,
              sent: r.result.sent,
              detail: r.result.sent ? `messageId: ${r.result.messageId}` : `${r.result.reason}: ${r.result.detail}`,
            })),
          });
        }
      } catch (err) {
        console.warn(`[AutoFire] failed for ${numberKey}:`, (err as Error)?.message ?? err);
      }
    });

    // ── Stage 2: Perplexity Sonar deep-research synthesis ──────────────────
    // Fires only on isNewlyActionable AND only if cache is stale (30-day TTL).
    // Cost-bounded: ~$0.005-0.01 per actionable case. Skips silently if no
    // PERPLEXITY_API_KEY. Result cached on offender for the petition pipeline.
    const needSonar = !offender.defendantWebResearch
      || !CaseBuilder.isFreshLookup(offender.defendantWebResearch.lookedUpAt, 30);
    if (needSonar) {
      researchTcpaDefendant(company)
        .then((r) => {
          const lookedUpAt = ("lookedUpAt" in r && r.lookedUpAt) ? r.lookedUpAt : new Date().toISOString();
          if (r.status === "match") {
            CaseBuilder.attachDefendantWebResearch(numberKey, {
              status: "match",
              summary: r.summary,
              citations: r.citations,
              model: r.model,
              lookedUpAt,
            });
            console.log(`[Research] Sonar (${r.model}) match for "${company}" — ${r.summary.length} chars, ${r.citations.length} citations, $${r.costUsd.toFixed(4)}`);
          } else if (r.status === "error") {
            CaseBuilder.attachDefendantWebResearch(numberKey, {
              status: "error",
              errorMessage: r.errorMessage,
              lookedUpAt,
            });
            console.warn(`[Research] Sonar error for "${company}": ${r.errorMessage}`);
          } else {
            CaseBuilder.attachDefendantWebResearch(numberKey, {
              status: "skipped",
              errorMessage: r.reason,
              lookedUpAt,
            });
          }
        })
        .catch((err) => console.warn(`[Research] Sonar threw for "${company}":`, err?.message ?? err));
    }
  }

  // ── Discord notification (fire-and-forget; never blocks the response) ──
  // Re-fetch the offender so we can include any just-attached checklist
  // quicklinks in the actionable embed.
  const checklistTopItems: Array<{ title: string; url?: string }> = [];
  if (isNewlyActionable) {
    const refreshed = CaseBuilder.getOffender(offender.normalizedNumber);
    if (refreshed?.evidenceChecklist) {
      // Top 3 actionable items with URLs (skip info-only and completed items)
      for (const it of refreshed.evidenceChecklist.items) {
        if (it.completed) continue;
        if (it.action !== "url") continue;
        checklistTopItems.push({ title: it.title, url: it.url });
        if (checklistTopItems.length >= 3) break;
      }
    }
  }

  Discord.notifyCallLogged({
    callerPhone,
    companyName: extractedCompany ?? null,
    callerName: extractedCallerName ?? null,
    callCount: offender.callCount,
    actionable: offender.actionable,
    isNewlyActionable,
    damagesEstimate: offender.damagesEstimate,
    grade,
    transcriptSnippet: snippet,
    checklistTopItems: checklistTopItems.length > 0 ? checklistTopItems : undefined,
  }).catch((err) => console.warn("[Discord] notify failed:", err?.message ?? err));

  res.json({
    ok: true,
    callCount: offender.callCount,
    actionable: offender.actionable,
    isNewlyActionable,
    damagesEstimate: offender.damagesEstimate,
    grade: { letter: grade.grade, score: grade.score, hangUpRisk: grade.hangUpRisk, missingInfo: grade.missingInfo },
  });
});

// Attach a Twilio recording URL to an already-logged spam call.
// Called from Reed's recording-status webhook after Twilio finishes processing the recording.
// The call entry was logged at call-end (via /api/cases/log) with recordingUrl=null;
// this backfills the URL once it becomes available.
app.post("/api/cases/set-recording", (req, res) => {
  const { callSid, recordingUrl } = req.body as {
    callSid?: string;
    recordingUrl?: string;
  };

  if (!callSid || !recordingUrl) {
    res.status(400).json({ error: "callSid and recordingUrl required" });
    return;
  }

  const found = CaseBuilder.attachRecording(callSid, recordingUrl);
  console.log(`[API] /cases/set-recording — callSid=${callSid} found=${found}`);
  res.json({ ok: true, found });
});

// ─────────────────────────────────────────────────────────────────────────────
//  Dashboard — single endpoint that powers the standalone dashboard.html page
//  served at /dashboard. Aggregates everything in one shape so the page only
//  makes one API call.
// ─────────────────────────────────────────────────────────────────────────────

import * as path_ from "path";
import { verificationSummary } from "./services/statuteRegistry";

app.get("/api/dashboard/stats", (_req, res) => {
  const allOffenders = CaseBuilder.getAllOffenders();
  const now = Date.now();
  const ONE_DAY = 24 * 60 * 60 * 1000;

  // ── Test data partitioning ────────────────────────────────────────────
  // Hide isTest offenders from the headline metrics so synthetic seed data
  // doesn't inflate the damages / verdict-mix / readiness tiles. They still
  // appear in their own sidebar so test runs are visible.
  const offenders = allOffenders.filter((o) => o.isTest !== true);
  const testOffenders = allOffenders.filter((o) => o.isTest === true);

  // ── Bucket offenders for the "potential cases" section ─────────────────
  const readyToFile = offenders.filter((o) => o.actionable && !o.filedAt);
  const filed = offenders.filter((o) => !!o.filedAt);
  const watching = offenders.filter((o) => !o.actionable && (o.callCount ?? 0) >= 1);

  // ── Flatten all CallEntries for grade trend analysis ──────────────────
  type FlatCall = { date: string; grade?: { letter: string; score: number; hangUpRisk: string; missingInfo: string[] }; recordingUrl: string | null };
  const allCalls: FlatCall[] = [];
  for (const o of offenders) {
    for (const c of o.calls ?? []) {
      allCalls.push({ date: c.date, grade: c.grade, recordingUrl: c.recordingUrl });
    }
  }

  // Bucket calls by recency
  const callsInWindow = (days: number): FlatCall[] => {
    const cutoff = now - days * ONE_DAY;
    return allCalls.filter((c) => {
      const t = new Date(c.date + "T00:00:00Z").getTime();
      return !isNaN(t) && t >= cutoff;
    });
  };

  // Compute grade aggregates over an array of calls
  const gradeAggregate = (calls: FlatCall[]) => {
    const graded = calls.filter((c) => c.grade && c.grade.letter !== "INCOMPLETE");
    const incomplete = calls.filter((c) => c.grade?.letter === "INCOMPLETE").length;
    const ungraded = calls.filter((c) => !c.grade).length;
    const avgScore = graded.length > 0
      ? Math.round(graded.reduce((s, c) => s + (c.grade?.score ?? 0), 0) / graded.length)
      : 0;
    const bands: Record<string, number> = { A: 0, B: 0, C: 0, D: 0, F: 0, INCOMPLETE: 0 };
    for (const c of calls) if (c.grade) bands[c.grade.letter] = (bands[c.grade.letter] ?? 0) + 1;
    const extracted = (field: "company" | "name" | "purpose" | "recording") => {
      if (graded.length === 0) return 0;
      const got = graded.filter((c) => !c.grade?.missingInfo?.includes(field)).length;
      return Math.round((got / graded.length) * 100);
    };
    const hangUp = (risk: "low" | "medium" | "high") => {
      if (graded.length === 0) return 0;
      const n = graded.filter((c) => c.grade?.hangUpRisk === risk).length;
      return Math.round((n / graded.length) * 100);
    };
    return {
      total: calls.length, graded: graded.length, incomplete, ungraded,
      averageScore: avgScore, bands,
      extractionRates: {
        company: extracted("company"), name: extracted("name"),
        purpose: extracted("purpose"), recording: extracted("recording"),
      },
      hangUpRisk: { low: hangUp("low"), medium: hangUp("medium"), high: hangUp("high") },
    };
  };

  // ── Daily grade-score series for the trend chart (last 14 days) ───────
  const dailySeries: Array<{ date: string; avgScore: number; callCount: number }> = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date(now - i * ONE_DAY);
    const dateStr = d.toISOString().split("T")[0];
    const calls = allCalls.filter((c) => c.date === dateStr && c.grade && c.grade.letter !== "INCOMPLETE");
    const avg = calls.length > 0 ? Math.round(calls.reduce((s, c) => s + (c.grade?.score ?? 0), 0) / calls.length) : 0;
    dailySeries.push({ date: dateStr, avgScore: avg, callCount: calls.length });
  }

  // ── Research status counters ──────────────────────────────────────────
  const lookedUp = offenders.filter((o) => !!o.lineTypeLookup).length;
  const recordedCalls = allCalls.filter((c) => !!c.recordingUrl).length;
  const totalDamages = offenders.filter((o) => o.actionable && !o.filedAt)
    .reduce((s, o) => s + (o.damagesEstimate ?? 0), 0);

  // Actionable-only enrichment counters (these only fire on actionable cases).
  // Each lookup partitions into 4 buckets: researched (match+no_match) /
  // skipped (intentionally not called, e.g. no API key) / errored / pending.
  // The dashboard treats skipped + errored separately from "still pending"
  // so an opt-in integration like OpenCorporates doesn't display as
  // "0/N pending forever" when the user hasn't enabled it.
  const actionable = offenders.filter((o) => o.actionable);
  const entityResearched = actionable.filter((o) => o.entityLookup?.status === "match" || o.entityLookup?.status === "no_match").length;
  const entitySkipped = actionable.filter((o) => o.entityLookup?.status === "skipped").length;
  const entityErrored = actionable.filter((o) => o.entityLookup?.status === "error").length;
  const litigationResearched = actionable.filter((o) => o.priorLitigation?.status === "match" || o.priorLitigation?.status === "no_match").length;
  const litigationSkipped = actionable.filter((o) => o.priorLitigation?.status === "skipped").length;
  const litigationErrored = actionable.filter((o) => o.priorLitigation?.status === "error").length;
  const sonarResearched = actionable.filter((o) => o.defendantWebResearch?.status === "match").length;
  const sonarErrored = actionable.filter((o) => o.defendantWebResearch?.status === "error").length;
  const sonarSkipped = actionable.filter((o) => o.defendantWebResearch?.status === "skipped").length;

  // ── Citation registry health ──────────────────────────────────────────
  const citationHealth = verificationSummary();

  // ── Bot self-improvement: today vs 7d vs 30d ──────────────────────────
  const today = gradeAggregate(callsInWindow(1));
  const last7 = gradeAggregate(callsInWindow(7));
  const last30 = gradeAggregate(callsInWindow(30));

  res.json({
    generatedAt: new Date().toISOString(),
    potentialCases: {
      readyToFile: readyToFile.map((o) => {
        const cl = o.evidenceChecklist;
        const totalItems = cl?.items.length ?? 0;
        const doneItems = cl?.items.filter((i) => i.completed).length ?? 0;
        // Compute the GO / WAIT / DON'T FILE verdict for the dashboard badge.
        // Cheap (no network calls) — just runs caseStrength + collectability
        // + evidence-completeness against cached profile data.
        let verdict = null;
        try {
          const d = decideFiling(o);
          verdict = {
            verdict: d.verdict,
            confidence: d.confidence,
            expectedValueUsd: d.expectedValueUsd,
            costEstimateUsd: d.costEstimateUsd,
            netUsd: d.expectedValueUsd - d.costEstimateUsd,
          };
        } catch { /* leave verdict null on error */ }
        return {
          normalizedNumber: o.normalizedNumber,
          companyName: o.companyName,
          callerName: o.callerNames?.[0] ?? null,
          callCount: o.callCount,
          damagesEstimate: o.damagesEstimate,
          firstCallDate: o.firstCallDate,
          lastCallDate: o.lastCallDate,
          willful: o.willful,
          lineType: o.lineTypeLookup?.normalizedType ?? null,
          checklist: cl ? { total: totalItems, done: doneItems } : null,
          verdict,
        };
      }),
      watching: watching.map((o) => ({
        normalizedNumber: o.normalizedNumber,
        companyName: o.companyName,
        callCount: o.callCount,
        callsToActionable: Math.max(0, 2 - (o.callCount ?? 0)),
        lastCallDate: o.lastCallDate,
      })),
      filed: filed.map((o) => ({
        normalizedNumber: o.normalizedNumber,
        companyName: o.companyName,
        filedAt: o.filedAt,
        filedCaseRef: o.filedCaseRef,
      })),
      summary: {
        readyCount: readyToFile.length,
        watchingCount: watching.length,
        filedCount: filed.length,
        totalDamagesAvailable: totalDamages,
      },
    },
    pipeline: (() => {
      // Composite per-case readiness numbers + headline aggregates that the
      // dashboard surfaces as tiles. Cheap — runs over already-loaded offenders.
      const willfulCount = readyToFile.filter((o) => o.willful).length;
      const identifiedCount = readyToFile.filter((o) => !!o.companyName).length;
      const identifiedPct = readyToFile.length > 0
        ? Math.round((identifiedCount / readyToFile.length) * 100)
        : 0;
      const recordingsTotal = allCalls.filter((c) => !!c.recordingUrl).length;
      // GO / WAIT / DON'T FILE roll-up (recompute from cached profile state)
      let goCount = 0, waitCount = 0, dontCount = 0;
      let readinessSum = 0;
      let readinessN = 0;
      let strengthSum = 0;
      let strengthN = 0;
      let collectSum = 0;
      let collectN = 0;
      let evidencePctSum = 0;
      let evidenceN = 0;
      let evNetSum = 0;          // sum of net EV across all ready cases
      const topDamages: Array<{ normalizedNumber: string; companyName: string | null; damagesEstimate: number; callCount: number }> = [];
      for (const o of readyToFile) {
        try {
          const d = decideFiling(o);
          if (d.verdict === "GO") goCount++;
          else if (d.verdict === "WAIT") waitCount++;
          else dontCount++;
          evNetSum += (d.expectedValueUsd - d.costEstimateUsd);
          if (typeof d.breakdown.caseStrengthScore === "number") {
            strengthSum += d.breakdown.caseStrengthScore;
            strengthN++;
          }
          if (typeof d.breakdown.collectabilityScore === "number") {
            collectSum += d.breakdown.collectabilityScore;
            collectN++;
          }
          if (typeof d.breakdown.evidenceCompletenessPct === "number") {
            evidencePctSum += d.breakdown.evidenceCompletenessPct;
            evidenceN++;
          }
          // Composite filing-readiness — same formula as case-file endpoint.
          // Round 26.0b (P-approved BB260b): apply the same defendant-ID
          // gate (cap at 80 when companyName is missing) so the dashboard
          // headline tile matches per-case readiness shown in the drawer.
          const sScore = d.breakdown.caseStrengthScore ?? 0;
          const cScore = d.breakdown.collectabilityScore ?? 50;
          const ePct = d.breakdown.evidenceCompletenessPct ?? 0;
          const idScore = o.companyName ? 100 : 0;
          const rawCase = Math.round((sScore * 0.30) + (cScore * 0.30) + (ePct * 0.30) + (idScore * 0.10));
          readinessSum += idScore === 0 ? Math.min(rawCase, 80) : rawCase;
          readinessN++;
        } catch { /* ignore per-case decision errors */ }
        topDamages.push({
          normalizedNumber: o.normalizedNumber,
          companyName: o.companyName,
          damagesEstimate: o.damagesEstimate ?? 0,
          callCount: o.callCount,
        });
      }
      topDamages.sort((a, b) => b.damagesEstimate - a.damagesEstimate);
      // Calls today / 7d (count of CallEntries, not graded count)
      const callsToday = allCalls.filter((c) => {
        const t = new Date(c.date + "T00:00:00Z").getTime();
        return !isNaN(t) && (now - t) < ONE_DAY;
      }).length;
      const calls7d = callsInWindow(7).length;
      return {
        verdictMix: { go: goCount, wait: waitCount, dontFile: dontCount },
        avgFilingReadinessPct: readinessN > 0 ? Math.round(readinessSum / readinessN) : 0,
        avgCaseStrength: strengthN > 0 ? Math.round(strengthSum / strengthN) : 0,
        avgCollectability: collectN > 0 ? Math.round(collectSum / collectN) : 0,
        avgEvidencePct: evidenceN > 0 ? Math.round(evidencePctSum / evidenceN) : 0,
        defendantIdRate: identifiedPct,
        willfulCount,
        netExpectedReturnUsd: Math.round(evNetSum),
        recordingsTotal,
        callsToday,
        calls7d,
        topByDamages: topDamages.slice(0, 5),
      };
    })(),
    research: {
      offendersTotal: offenders.length,
      actionableTotal: actionable.length,
      lineTypeLookupsCompleted: lookedUp,
      lineTypeLookupsPending: offenders.length - lookedUp,
      entityResearched,
      entitySkipped,
      entityErrored,
      entityPending: Math.max(0, actionable.length - entityResearched - entitySkipped - entityErrored),
      litigationResearched,
      litigationSkipped,
      litigationErrored,
      litigationPending: Math.max(0, actionable.length - litigationResearched - litigationSkipped - litigationErrored),
      sonarResearched,
      sonarErrored,
      sonarSkipped,
      sonarPending: Math.max(0, actionable.length - sonarResearched - sonarErrored - sonarSkipped),
      recordedCalls,
      callsTotal: allCalls.length,
      recordingCoverage: allCalls.length > 0 ? Math.round((recordedCalls / allCalls.length) * 100) : 0,
      citationRegistry: citationHealth,
    },
    botSelfImprovement: {
      today,
      last7,
      last30,
      dailySeries,
    },
    testCases: testOffenders.map((o) => ({
      normalizedNumber: o.normalizedNumber,
      companyName: o.companyName,
      callCount: o.callCount,
      actionable: o.actionable,
      damagesEstimate: o.damagesEstimate,
      lastCallDate: o.lastCallDate,
      markedTestAt: o.markedTestAt,
    })),
  });
});

// User management
app.get("/api/users", (_req, res) => {
  res.json(UserManager.getActiveUsers());
});

app.get("/api/users/:phone", (req, res) => {
  const user = UserManager.getUser(req.params.phone);
  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }
  res.json(user);
});

// ── Start ────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// AUDIT_ROUND_20: evidence-checklist reminder cadence
//
// Every 1 hour, scan all actionable offenders. For each one with a checklist
// where:
//   - at least one item is still incomplete, AND
//   - the last reminder was > 24h ago (or never sent), AND
//   - the case is < 14 days old (after which ITG traceback success drops),
// fire a Discord reminder embed listing the still-open items.
//
// .unref() so it doesn't block clean shutdown.
// ─────────────────────────────────────────────────────────────────────────────

const REMINDER_INTERVAL_MS = 60 * 60 * 1000;            // hourly scan
const REMINDER_COOLDOWN_MS = 24 * 60 * 60 * 1000;       // don't ping more than once per day
const CASE_AGE_LIMIT_MS = 14 * 24 * 60 * 60 * 1000;     // stop reminding after 14 days

// AUDIT_ROUND_23: background pump for auto-fire of newly-unlocked items.
// Hourly scan for actionable cases whose pressure stack now has unlocked
// items (because Sonar found a website, or — once we wire it — ITG returned
// a carrier identification). Marks fired items on the offender so we don't
// double-fire on the next pass.
const autoFiredFlag: Set<string> = new Set();  // dedupe within process lifetime
setInterval(() => {
  if (!process.env.AUTO_SEND_PRESSURE || process.env.AUTO_SEND_PRESSURE.toLowerCase() !== "true") return;
  try {
    const offenders = CaseBuilder.getAllOffenders();
    const userCtx = loadUserContextForChecklist();
    for (const o of offenders) {
      if (!o.actionable || o.filedAt) continue;
      // Sonar website surfaced?
      const sonarSummary = o.defendantWebResearch?.status === "match" ? o.defendantWebResearch.summary ?? "" : "";
      const websiteMatch = sonarSummary.match(/https?:\/\/[^\s)]+/);
      const websiteKey = websiteMatch ? `web:${o.normalizedNumber}:${websiteMatch[0]}` : null;
      // Future hook: ITG response → o.itgTraceback?.originatingCarrier — once we
      // build the ITG response ingest. For now only website-based items unlock.
      const unlock: { websiteUrl?: string } = {};
      if (websiteMatch && !autoFiredFlag.has(websiteKey!)) {
        unlock.websiteUrl = websiteMatch[0];
      }
      if (!unlock.websiteUrl) continue;

      autoFiredFlag.add(websiteKey!);
      autoFireUnlockedItems(o, userCtx, unlock)
        .then((results) => {
          if (results.length === 0) return;
          results.forEach((r) =>
            console.log(`[AutoFireBG] ${o.normalizedNumber} ${r.itemId} → ${r.recipient}: ${r.result.sent ? "SENT" : "skip/error"}`)
          );
          return Discord.notifyAutoFire({
            callerPhone: o.normalizedNumber,
            companyName: o.companyName,
            results: results.map((r) => ({
              title: r.title,
              recipient: r.recipient,
              sent: r.result.sent,
              detail: r.result.sent ? `messageId: ${r.result.messageId}` : `${r.result.reason}: ${r.result.detail}`,
            })),
          });
        })
        .catch((err) => console.warn("[AutoFireBG] failed:", err?.message ?? err));
    }
  } catch (err) {
    console.warn("[AutoFireBG] scan failed:", (err as Error).message);
  }
}, 60 * 60 * 1000).unref?.();  // hourly

setInterval(() => {
  try {
    const offenders = CaseBuilder.getAllOffenders();
    const now = Date.now();
    for (const o of offenders) {
      if (!o.actionable || o.filedAt) continue;
      const cl = o.evidenceChecklist;
      if (!cl) continue;
      const incomplete = cl.items.filter((i) => !i.completed);
      if (incomplete.length === 0) continue;

      const ageMs = now - new Date(cl.generatedAt).getTime();
      if (isNaN(ageMs) || ageMs > CASE_AGE_LIMIT_MS) continue;

      const lastReminder = cl.lastReminderAt ? new Date(cl.lastReminderAt).getTime() : 0;
      if (now - lastReminder < REMINDER_COOLDOWN_MS) continue;

      const links = incomplete
        .filter((i) => i.action === "url")
        .map((i) => ({ title: i.title, url: i.url }))
        .slice(0, 5);

      Discord.notifyChecklistReminder({
        callerPhone: o.normalizedNumber,
        companyName: o.companyName,
        callCount: o.callCount,
        damagesEstimate: o.damagesEstimate ?? 0,
        hoursElapsed: ageMs / (60 * 60 * 1000),
        incompleteItems: links,
      })
        .then(() => CaseBuilder.markChecklistReminded(o.normalizedNumber))
        .catch((err) => console.warn("[ChecklistReminder] failed:", err?.message ?? err));
    }
  } catch (err) {
    console.warn("[ChecklistReminder] scan failed:", (err as Error).message);
  }
}, REMINDER_INTERVAL_MS).unref?.();

// ─────────────────────────────────────────────────────────────────────────────
// AUDIT_ROUND_24: scheduled health monitor — runs runMonitor() every 5 min,
// dispatches Discord alarms for state transitions, and (if AUTO_RESTART_ON_SILENT_BOT=true)
// triggers a Render redeploy when a bot's silent-failure rate crosses the
// threshold. Hourly cap on auto-restarts per bot to prevent restart loops.
// ─────────────────────────────────────────────────────────────────────────────

const HEALTH_INTERVAL_MS = 5 * 60 * 1000;          // 5 min
const RESTART_COOLDOWN_MS = 60 * 60 * 1000;        // don't auto-restart same bot more than 1x/hr
const lastAutoRestart: Map<string, number> = new Map();

setInterval(async () => {
  try {
    const result = await runMonitor();
    for (const t of result.transitions) {
      Discord.notifyAlarm({
        alarmId: t.alarmId,
        transitionTo: t.to,
        message: t.message,
        durationMs: t.durationMs,
        context: [{ name: "Alarm ID", value: t.alarmId }],
      }).catch((err) => console.warn("[HealthMonitor] Discord notify failed:", err?.message));
    }

    // ── Optional auto-restart ─────────────────────────────────────────
    // Only fires if AUTO_RESTART_ON_SILENT_BOT=true and the silent-failure
    // alarm just transitioned to broken (not already broken on prior scan).
    if ((process.env.AUTO_RESTART_ON_SILENT_BOT ?? "false").toLowerCase() === "true") {
      for (const t of result.transitions) {
        if (t.to !== "broken") continue;
        if (!t.alarmId.startsWith("bot-silent-failure:")) continue;
        const slug = t.alarmId.split(":")[1];
        const bot = BOTS_TO_MONITOR.find((b) => b.slug === slug);
        if (!bot) continue;
        const lastTry = lastAutoRestart.get(slug) ?? 0;
        if (Date.now() - lastTry < RESTART_COOLDOWN_MS) {
          console.log(`[AutoRestart] cooldown active for ${slug}; skipping`);
          continue;
        }
        lastAutoRestart.set(slug, Date.now());
        console.log(`[AutoRestart] silent-failure alarm tripped for ${slug} — triggering Render redeploy`);
        const r = await triggerRenderRedeploy(bot.renderServiceId);
        Discord.notifyAlarm({
          alarmId: `auto-restart:${slug}`,
          transitionTo: r.ok ? "ok" : "broken",
          message: r.ok
            ? `🔄 Auto-restart triggered for ${slug} (deploy ${r.deployId}). Monitor will verify recovery on the next 5-min pass.`
            : `Auto-restart FAILED for ${slug}: ${r.error}`,
        }).catch(() => undefined);
      }
    }
  } catch (err) {
    console.warn("[HealthMonitor] scan failed:", (err as Error).message);
  }
}, HEALTH_INTERVAL_MS).unref?.();

app.listen(PORT, () => {
  const users = UserManager.getUserCount();
  console.log("═".repeat(55));
  console.log("  SpamSlayer — TCPA Compliance Bot");
  console.log(`  Listening on http://localhost:${PORT}`);
  console.log(`  Users: ${users.active} active / ${users.total} total`);
  console.log(`  SpamSlayer number: ${process.env.TWILIO_PHONE_NUMBER ?? "(not set)"}`);
  console.log("  Voice webhook: /api/phone/inbound");
  console.log("  SMS webhook:   /api/sms/inbound");
  console.log("═".repeat(55));

  // Keep-alive: ping own health endpoint every 14 min so Render free tier
  // doesn't spin down (spins down after 15 min of no inbound traffic).
  const selfUrl = (process.env.BASE_URL ?? process.env.RENDER_EXTERNAL_URL ?? "").replace(/\/$/, "");
  if (selfUrl) {
    setInterval(() => {
      fetch(`${selfUrl}/api/health`)
        .then(() => console.log("[Heartbeat] ok"))
        .catch((err: Error) => console.warn("[Heartbeat] failed:", err.message));
    }, 14 * 60 * 1000);
    console.log(`  Heartbeat: every 14 min → ${selfUrl}/api/health`);
  }
});
