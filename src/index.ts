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
import * as LegalFiling from "./services/legalFilingGenerator";
import * as StrengthMeter from "./services/caseStrengthMeter";
import * as DemoSeed from "./services/demoSeed";
import * as OpenCorporates from "./services/openCorporatesClient";
import * as TwilioLookup from "./services/twilioLookupClient";
import * as CourtListener from "./services/courtListenerClient";
import * as DefendantResearch from "./services/defendantResearch";
import fs from "fs";

const app = express();
const PORT = parseInt(process.env.PORT ?? "3003", 10);

// B3 (AUDIT_ROUND_15): lock down CORS. This server holds unauthenticated
// endpoints that (a) read PII-laden case data and (b) write the phone.json
// config that drives generated legal filings. A wide-open CORS policy would
// let any website the user happens to visit read or tamper with that data
// via the browser. Restrict to loopback origins only; if the user needs a
// LAN-visible install later they can extend this list via env.
const ALLOWED_ORIGINS = (process.env.SPAMSLAYER_ALLOWED_ORIGINS ?? "")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);
const DEFAULT_ALLOWED = [
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "http://localhost:3003",
  "http://127.0.0.1:3003",
];
const ORIGIN_ALLOWLIST = new Set<string>([...DEFAULT_ALLOWED, ...ALLOWED_ORIGINS]);

app.use(
  cors({
    origin: (origin, callback) => {
      // Allow same-origin / curl / server-to-server (no Origin header).
      if (!origin) return callback(null, true);
      if (ORIGIN_ALLOWLIST.has(origin)) return callback(null, true);
      return callback(new Error("CORS: origin not allowed"));
    },
    credentials: false,
  })
);

// Belt-and-suspenders: also refuse any non-Twilio mutating request whose
// Origin header is present but not in the allowlist. Defends against
// CORS-enabled browsers respecting preflight but the cross-origin fetch
// arriving anyway (simple requests), and mitigates CSRF on POSTs.
app.use((req, res, next) => {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") {
    return next();
  }
  // Twilio webhooks are separately protected by validateTwilio signature check.
  if (req.path.startsWith("/api/phone") || req.path.startsWith("/api/sms")) {
    return next();
  }
  const origin = req.header("origin");
  if (origin && !ORIGIN_ALLOWLIST.has(origin)) {
    res.status(403).json({ error: "Forbidden origin." });
    return;
  }
  return next();
});

app.use(express.urlencoded({ extended: false })); // Twilio sends form-encoded
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

// Check if a number is a known offender — used by Reed to route calls
app.get("/api/cases/check", (req, res) => {
  const phone = (req.query.phone as string) || "";
  if (!phone) { res.status(400).json({ error: "phone required" }); return; }
  const offender = CaseBuilder.getOffender(CaseBuilder.normalizePhone(phone));
  res.json({ known: !!offender, callCount: offender?.callCount ?? 0 });
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

  console.log(
    `[API] /cases/log — caller=${callerPhone} company=${extractedCompany ?? "?"} ` +
    `callCount=${offender.callCount} actionable=${offender.actionable} newlyActionable=${isNewlyActionable}`
  );

  res.json({
    ok: true,
    callCount: offender.callCount,
    actionable: offender.actionable,
    isNewlyActionable,
    damagesEstimate: offender.damagesEstimate,
  });
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

// ── Filing package endpoints ─────────────────────────────────────────────

// Preview the filing package (generates in memory, does not save to disk,
// does not mark offender as filed). Safe to call repeatedly.
app.get("/api/cases/filing/:number", (req, res) => {
  try {
    const normalized = CaseBuilder.normalizePhone(req.params.number);
    const offender = CaseBuilder.getOffender(normalized);
    if (!offender) {
      res.status(404).json({ error: "No case found for this number." });
      return;
    }
    if (!offender.actionable) {
      res.status(400).json({
        error: "Case is not yet actionable.",
        detail: `Need at least 2 calls within a 12-month window. Currently have ${offender.callCount} call(s).`,
      });
      return;
    }
    // Demo-phone special case: auto-apply safe demo config so the lawyer
    // demo works even when the user hasn't filled in Settings → Legal yet.
    // NEVER applies to real offenders.
    const overrides = DemoSeed.isDemoOffender(normalized)
      ? DemoSeed.DEMO_FILING_OVERRIDES
      : undefined;
    const pkg = LegalFiling.generateFilingPackage(normalized, overrides);
    if (!pkg) {
      res.status(400).json({
        error: "Filing package could not be generated.",
        detail: "This usually means the case is blocked by a statute-of-limitations issue or is missing required information. Check the server logs for details.",
      });
      return;
    }
    res.json(pkg);
  } catch (err: any) {
    console.error("[API] /cases/filing preview failed:", err);
    res.status(500).json({ error: "Internal error", detail: err?.message ?? String(err) });
  }
});

// Generate AND save the filing package to disk, marking the offender as filed.
// This is the "I'm actually filing this" endpoint — heavier action.
app.post("/api/cases/filing/:number/save", (req, res) => {
  try {
    const normalized = CaseBuilder.normalizePhone(req.params.number);
    const overrides = DemoSeed.isDemoOffender(normalized)
      ? DemoSeed.DEMO_FILING_OVERRIDES
      : undefined;
    const result = LegalFiling.generateAndSaveFilingPackage(normalized, undefined, overrides);
    if (!result) {
      res.status(400).json({ error: "Filing package could not be generated or saved." });
      return;
    }
    res.json({
      ok: true,
      dir: result.dir,
      files: result.files.map((f) => f.split("/").pop()),
    });
  } catch (err: any) {
    // Layer 1c: citation gate refused the save. Return 422 with the full
    // blocking-message list so the UI can render a plain-English refusal
    // screen instead of a generic 500. The user cannot sign a sworn
    // filing that contains a bad citation — that's the whole point of
    // the gate. Save again after the flagged citations are fixed in
    // statuteRegistry.ts or in the source code that emits them.
    if (err instanceof LegalFiling.CitationGateError) {
      console.error(
        `[API] /cases/filing save refused by citation gate: ` +
        `${err.blockingMessages.length} issue(s).`,
      );
      res.status(422).json({
        error: "Filing cannot be saved: citation verifier refused.",
        detail:
          "SpamSlayer found one or more legal citations in your filing that " +
          "are either not in its registry, do not match the subsection they " +
          "are cited for, or could not be parsed. A sworn filing with a bad " +
          "citation is a real sanction risk. Fix the issues listed below and " +
          "try again.",
        blockingIssues: err.blockingMessages,
      });
      return;
    }
    console.error("[API] /cases/filing save failed:", err);
    res.status(500).json({ error: "Internal error", detail: err?.message ?? String(err) });
  }
});

// R20: Complaint-bundle preview. Returns only the bundle portion of the
// filing package so the UI can display the "File Everywhere" drafts
// without rendering the full petition.
app.get("/api/cases/complaint-bundle/:number", (req, res) => {
  try {
    const normalized = CaseBuilder.normalizePhone(req.params.number);
    const offender = CaseBuilder.getOffender(normalized);
    if (!offender) {
      res.status(404).json({ error: "No case found for this number." });
      return;
    }
    if (!offender.actionable) {
      res.status(400).json({
        error: "Case is not yet actionable.",
        detail: `Need at least 2 calls within a 12-month window. Currently have ${offender.callCount} call(s).`,
      });
      return;
    }
    const overrides = DemoSeed.isDemoOffender(normalized)
      ? DemoSeed.DEMO_FILING_OVERRIDES
      : undefined;
    const pkg = LegalFiling.generateFilingPackage(normalized, overrides);
    if (!pkg) {
      res.status(400).json({ error: "Filing package could not be generated." });
      return;
    }
    res.json(pkg.complaintBundle);
  } catch (err: any) {
    console.error("[API] /cases/complaint-bundle failed:", err);
    res.status(500).json({ error: "Internal error", detail: err?.message ?? String(err) });
  }
});

// Case strength assessment (used by Case Detail view)
app.get("/api/cases/strength/:number", (req, res) => {
  try {
    const normalized = CaseBuilder.normalizePhone(req.params.number);
    const report = StrengthMeter.evaluateCaseStrength(normalized);
    if (!report) {
      res.status(404).json({ error: "No offender found." });
      return;
    }
    res.json(report);
  } catch (err: any) {
    console.error("[API] /cases/strength failed:", err);
    res.status(500).json({ error: "Internal error", detail: err?.message ?? String(err) });
  }
});

// Defendant research lookup. Orchestrates THREE on-demand network calls
// (triggered by the user's "Look up this defendant" button) — never
// automatic:
//
//   1. OpenCorporates    — entity registry (active / dissolved / no-match)
//   2. Twilio Lookup v2  — line-type intelligence (landline / mobile / VoIP)
//   3. CourtListener     — federal RECAP litigation history (TCPA prior cases)
//
// All three run in parallel via Promise.allSettled so a single upstream
// outage cannot block the others. Each underlying client is "never throws"
// by design; allSettled is belt-and-suspenders.
//
// Safety:
//   • Nothing from this endpoint writes into the petition. Petition text
//     is generated from offender.companyName, which is user-confirmed.
//   • Network failures surface as status:"error" inside the response so
//     the caller UI can render the failure message. HTTP 500 is reserved
//     for unexpected code paths.
//   • Errors and skipped lookups produce zero scoring impact — by design.
//     We never penalize a defendant because OUR network had a bad day.
//   • CourtListener only indexes FEDERAL court records; state-court
//     small-claims TCPA suits won't appear. The UI must convey this.
app.post("/api/cases/enrich-defendant/:number", async (req, res) => {
  try {
    const normalized = CaseBuilder.normalizePhone(req.params.number);
    const offender = CaseBuilder.getOffender(normalized);
    if (!offender) {
      res.status(404).json({ error: "No case found for this number." });
      return;
    }
    const companyName = (offender.companyName ?? "").trim();
    const offenderPhone = (offender.normalizedNumber ?? "").toString().trim();
    const forceRefresh = req.body?.forceRefresh === true;

    // Read the user's home state (if set in phone.json) to scope the
    // OpenCorporates search — dramatically reduces false positives.
    let jurisdictionCode: string | null = null;
    try {
      if (fs.existsSync(PHONE_CONFIG_PATH)) {
        const cfg = JSON.parse(fs.readFileSync(PHONE_CONFIG_PATH, "utf-8"));
        const userState = cfg?.filingConfig?.userState;
        jurisdictionCode = OpenCorporates.jurisdictionCodeFromUsState(userState);
      }
    } catch {
      // Best-effort — fall through with no jurisdiction.
    }

    // ── Build per-lookup promises ────────────────────────────────────
    // Each lookup is independently skippable. We deliberately produce a
    // typed "skipped" result for the missing-input case rather than
    // letting the underlying client return its own — this keeps the
    // skip-reason close to the orchestrator and consistent with what
    // the UI renders.
    const entityPromise: Promise<OpenCorporates.EntityLookupResult> = companyName
      ? OpenCorporates.lookupEntity(companyName, { jurisdictionCode, forceRefresh })
      : Promise.resolve({
          status: "skipped",
          reason: "No company name on this case yet. Identify the caller first.",
        });

    const linePromise: Promise<TwilioLookup.LineLookupResult> = offenderPhone
      ? TwilioLookup.lookupLineType(offenderPhone, { forceRefresh })
      : Promise.resolve({
          status: "skipped",
          reason: "No offender phone number on this case.",
        });

    const litigationPromise: Promise<CourtListener.LitigationLookupResult> = companyName
      ? CourtListener.lookupPriorLitigation(companyName, { forceRefresh })
      : Promise.resolve({
          status: "skipped",
          reason: "No company name on this case yet. Identify the caller first.",
        });

    const [entitySettled, lineSettled, litigationSettled] = await Promise.allSettled([
      entityPromise,
      linePromise,
      litigationPromise,
    ]);

    // ── Unwrap allSettled results into the same union types ─────────
    // The underlying clients are "never throws" so the rejected branch is
    // a safety net for genuinely unexpected exceptions (e.g. OOM). When
    // hit, surface as status:"error" — never silently swallow.
    const entity: OpenCorporates.EntityLookupResult =
      entitySettled.status === "fulfilled"
        ? entitySettled.value
        : {
            status: "error",
            errorMessage: `Entity lookup raised: ${(entitySettled.reason as Error)?.message ?? "unknown error"}`,
          };

    const lineType: TwilioLookup.LineLookupResult =
      lineSettled.status === "fulfilled"
        ? lineSettled.value
        : {
            status: "error",
            errorMessage: `Line-type lookup raised: ${(lineSettled.reason as Error)?.message ?? "unknown error"}`,
          };

    const litigation: CourtListener.LitigationLookupResult =
      litigationSettled.status === "fulfilled"
        ? litigationSettled.value
        : {
            status: "error",
            errorMessage: `Litigation lookup raised: ${(litigationSettled.reason as Error)?.message ?? "unknown error"}`,
          };

    // ── Build the EnrichmentResult that defendantResearch consumes ──
    // The scoring module already understands all three signals via its
    // existing EnrichmentResult shape; we just have to translate.
    const enrichment: DefendantResearch.EnrichmentResult = {
      entity: entityLookupResultToEnrichment(entity),
    };

    if (lineType.status === "match") {
      enrichment.lineType = {
        type: lineType.normalizedType,
        carrier: lineType.carrierName ?? undefined,
        countryCode: lineType.countryCode ?? undefined,
      };
    }

    // priorLitigationCount only contributes to scoring when we actually
    // have a count. A no_match becomes 0, which by design produces no
    // signal (the bucketed scoring requires >= 1). Skipped/error leave
    // the field undefined entirely — no signal.
    if (litigation.status === "match") {
      enrichment.priorLitigationCount = litigation.caseCount;
    } else if (litigation.status === "no_match") {
      enrichment.priorLitigationCount = 0;
    }

    const collectability = DefendantResearch.scoreCollectability(offender, { enrichment });

    res.json({ entity, lineType, litigation, collectability });
  } catch (err: any) {
    console.error("[API] /cases/enrich-defendant failed:", err);
    res.status(500).json({ error: "Internal error", detail: err?.message ?? String(err) });
  }
});

/**
 * Narrow conversion between the OpenCorporates client's result type and
 * the shape defendantResearch's EntityEnrichment expects. Both share
 * discriminator values, so this is mostly a compile-time safety net.
 */
function entityLookupResultToEnrichment(
  r: OpenCorporates.EntityLookupResult
): DefendantResearch.EntityEnrichment {
  if (r.status === "match") {
    return {
      status: "match",
      matchedName: r.matchedName,
      companyNumber: r.companyNumber,
      jurisdictionCode: r.jurisdictionCode,
      normalizedStatus: r.normalizedStatus,
      rawStatus: r.rawStatus,
      incorporationDate: r.incorporationDate,
      registeredAddress: r.registeredAddress,
      sourceUrl: r.sourceUrl,
      lookedUpAt: r.lookedUpAt,
      matchConfidence: r.matchConfidence,
    };
  }
  if (r.status === "no_match") {
    return {
      status: "no_match",
      query: r.query,
      jurisdictionCode: r.jurisdictionCode,
      lookedUpAt: r.lookedUpAt,
    };
  }
  if (r.status === "skipped") return { status: "skipped", reason: r.reason };
  return { status: "error", errorMessage: r.errorMessage, httpStatus: r.httpStatus };
}

// ── Config endpoints ─────────────────────────────────────────────────────
// Read/write the phone.json config, including filingConfig. This is what
// the Settings view hits. Placeholders like "[YOUR NAME]" are kept so the
// UI can detect them and prompt the user.

const PHONE_CONFIG_PATH = path.resolve(__dirname, "..", "..", "phone.json");

app.get("/api/config", (_req, res) => {
  try {
    if (!fs.existsSync(PHONE_CONFIG_PATH)) {
      res.status(404).json({ error: "phone.json not found" });
      return;
    }
    const raw = fs.readFileSync(PHONE_CONFIG_PATH, "utf-8");
    const json = JSON.parse(raw);
    res.json(json);
  } catch (err: any) {
    console.error("[API] /config GET failed:", err);
    res.status(500).json({ error: "Could not read config", detail: err?.message });
  }
});

// B4 (AUDIT_ROUND_15): schema-validate every write to phone.json. This file
// drives generated legal filings — garbage in produces perjured filings out.
// The browser has no write access after CORS lockdown, but the user-facing
// Settings UI also hits this endpoint, so we still need to reject malformed
// bodies loudly rather than silently corrupting the config.
const DANGEROUS_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const ALLOWED_FILING_CONFIG_KEYS = new Set([
  "userName", "userAddress", "userCity", "userState", "userZip",
  "userPhone", "userEmail",
  "courtName", "courtAddress", "courtCity", "courtState", "courtZip",
  "courtClerkPhone", "parishOrCounty",
  "dncRegistrationDate",
  "filingFee", "serviceFee",
  "stateDncStatute", "stateRecordingLaw",
  "smallClaimsLimit", "smallClaimsStatute",
  "lineType",
]);
const ALLOWED_LINE_TYPES = new Set(["residential", "cellular", "mixed", "unspecified"]);
const MAX_FIELD_LEN = 500;
const MAX_BODY_BYTES = 64 * 1024;

function validateConfigBody(body: unknown): { ok: true } | { ok: false; reason: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, reason: "Request body must be a JSON object." };
  }
  const serialized = JSON.stringify(body);
  if (serialized.length > MAX_BODY_BYTES) {
    return { ok: false, reason: `Config too large (>${MAX_BODY_BYTES} bytes).` };
  }
  // Prototype-pollution defense: reject dangerous keys anywhere in the object.
  const walk = (node: unknown, path: string): string | null => {
    if (node === null || typeof node !== "object") return null;
    for (const key of Object.keys(node as Record<string, unknown>)) {
      if (DANGEROUS_KEYS.has(key)) return `Disallowed key "${key}" at ${path || "root"}.`;
      const child = (node as Record<string, unknown>)[key];
      if (child && typeof child === "object") {
        const nested = walk(child, path ? `${path}.${key}` : key);
        if (nested) return nested;
      }
    }
    return null;
  };
  const dangerousReason = walk(body, "");
  if (dangerousReason) return { ok: false, reason: dangerousReason };

  const fc = (body as { filingConfig?: unknown }).filingConfig;
  if (fc !== undefined) {
    if (!fc || typeof fc !== "object" || Array.isArray(fc)) {
      return { ok: false, reason: "filingConfig must be an object." };
    }
    for (const [k, v] of Object.entries(fc as Record<string, unknown>)) {
      if (!ALLOWED_FILING_CONFIG_KEYS.has(k)) {
        return { ok: false, reason: `Unknown filingConfig field: ${k}.` };
      }
      if (typeof v !== "string") {
        return { ok: false, reason: `filingConfig.${k} must be a string.` };
      }
      if (v.length > MAX_FIELD_LEN) {
        return { ok: false, reason: `filingConfig.${k} exceeds ${MAX_FIELD_LEN} chars.` };
      }
      // Reject control characters — they break PDF generation and can be
      // used to smuggle formatting into sworn petitions.
      // eslint-disable-next-line no-control-regex
      if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(v)) {
        return { ok: false, reason: `filingConfig.${k} contains control characters.` };
      }
      if (k === "lineType" && !ALLOWED_LINE_TYPES.has(v)) {
        return {
          ok: false,
          reason: `filingConfig.lineType must be one of: residential, cellular, mixed, unspecified.`,
        };
      }
    }
  }
  return { ok: true };
}

app.post("/api/config", (req, res) => {
  try {
    const body = req.body;
    const check = validateConfigBody(body);
    if (!check.ok) {
      res.status(400).json({ error: check.reason });
      return;
    }
    // Atomic write: temp file → rename. Don't allow partial writes to corrupt
    // a config file that drives legal filings.
    const tmp = PHONE_CONFIG_PATH + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(body, null, 2), { encoding: "utf-8", mode: 0o600 });
    fs.renameSync(tmp, PHONE_CONFIG_PATH);
    res.json({ ok: true });
  } catch (err: any) {
    console.error("[API] /config POST failed:", err);
    res.status(500).json({ error: "Could not save config", detail: err?.message });
  }
});

// ── Demo mode ────────────────────────────────────────────────────────────
// POST /api/demo/seed  — insert/refresh a fictional auto-warranty offender
// POST /api/demo/clear — remove the demo record
// GET  /api/demo/info  — describe the demo case (used by the UI banner)
//
// The demo phone number is +1-555-555-0199 (NANP reserved fictional range),
// and every transcript is tagged "[DEMO]" so nothing can be confused for
// a real complaint. See demoSeed.ts for the safety rationale.

app.post("/api/demo/seed", (_req, res) => {
  try {
    const result = DemoSeed.seedDemoCase();
    res.json({
      ok: true,
      created: result.created,
      demoPhone: DemoSeed.DEMO_PHONE,
      callCount: result.offender.callCount,
      damagesEstimate: result.offender.damagesEstimate,
    });
  } catch (err: any) {
    console.error("[API] /demo/seed failed:", err);
    res.status(500).json({ error: "Could not seed demo case", detail: err?.message ?? String(err) });
  }
});

app.post("/api/demo/clear", (_req, res) => {
  try {
    const result = DemoSeed.clearDemoCase();
    res.json({ ok: true, removed: result.removed });
  } catch (err: any) {
    console.error("[API] /demo/clear failed:", err);
    res.status(500).json({ error: "Could not clear demo case", detail: err?.message ?? String(err) });
  }
});

app.get("/api/demo/info", (_req, res) => {
  res.json({
    demoPhone: DemoSeed.DEMO_PHONE,
    description:
      "A fictional auto-warranty offender for demonstrating SpamSlayer. " +
      "Every transcript is tagged [DEMO]; the phone number is in the NANP " +
      "reserved fictional range (555-01XX) and cannot ring a real subscriber. " +
      "Any filing package or complaint bundle generated from this case is " +
      "for demonstration only and must not be submitted.",
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
});
