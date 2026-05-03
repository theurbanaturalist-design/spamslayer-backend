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
import { validateTwilio } from "./middleware/validateTwilio";
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

// ── Twilio webhook routes (signature-validated) ──────────────────────────
app.use("/api/phone", validateTwilio, phoneRouter);
app.use("/api/sms", validateTwilio, smsRouter);

// ── Public API routes (for frontend dashboard) ───────────────────────────

app.get("/api/health", (_req, res) => {
  res.json({
    status: "ok",
    service: "SpamSlayer",
    timestamp: new Date().toISOString(),
    users: UserManager.getUserCount(),
  });
});

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
    turns,
  } = req.body as {
    callSid?: string;
    callerPhone?: string;
    subscriberId?: string;
    extractedCompany?: string;
    extractedCallerName?: string;
    extractedPurpose?: string;
    turns?: Array<{ role: string; text: string }>;
  };

  if (!callerPhone) {
    res.status(400).json({ error: "callerPhone required" });
    return;
  }

  const snippet = (turns ?? [])
    .map((t) => `${t.role === "caller" ? "Caller" : "Bot"}: ${t.text}`)
    .join(" | ")
    .slice(0, 300);

  const { offender, isNewlyActionable } = CaseBuilder.logCall(
    subscriberId ?? "unknown",
    callerPhone,
    extractedCompany ?? null,
    extractedCallerName ?? null,
    extractedPurpose ?? null,
    callSid ?? "unknown",
    null,
    snippet,
    "telemarketing"
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
    `grade=${grade.grade}/${grade.score} hangUp=${grade.hangUpRisk}`
  );

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
  const offenders = CaseBuilder.getAllOffenders();
  const now = Date.now();
  const ONE_DAY = 24 * 60 * 60 * 1000;

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
