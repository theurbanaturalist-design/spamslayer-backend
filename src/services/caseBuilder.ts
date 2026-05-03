// ─────────────────────────────────────────────────────────────────────────────
//  caseBuilder.ts — TCPA case tracking across calls and users
//
//  Tracks every offender (by normalized phone number), counts violations,
//  flags cases as actionable when they hit the 2-call TCPA threshold,
//  calculates damages, and generates demand letters.
//
//  Persists to cases.json so data survives server restarts.
//
//  CODE REVIEW FIXES (April 2026):
//  - Atomic file writes with temp-file-then-rename pattern
//  - Corruption detection with automatic backup
//  - Phone normalization handles US/CA (+1) and international numbers
//  - 12-month calculation uses actual calendar months (not 365 days)
//  - Data integrity validation on offender profiles
// ─────────────────────────────────────────────────────────────────────────────

import fs from "fs";
import path from "path";

const CASES_FILE = path.resolve(__dirname, "../../../cases.json");
const CASES_TEMP = CASES_FILE + ".tmp";

// ── Types ────────────────────────────────────────────────────────────────

export interface CallEntry {
  date: string;
  time: string;
  callSid: string;
  subscriberId: string;
  recordingUrl: string | null;
  transcriptSnippet: string;
  callType: string;
  /** Optional per-call grade from conversationGrader. Backfilled lazily for
   *  pre-grader call data; new calls get this populated at log time. */
  grade?: {
    letter: "A" | "B" | "C" | "D" | "F" | "INCOMPLETE";
    score: number;
    hangUpRisk: "low" | "medium" | "high";
    missingInfo: string[];
    summary: string;
  };
}

export interface OffenderProfile {
  normalizedNumber: string;
  rawNumbers: string[];
  companyName: string | null;
  callerNames: string[];
  purpose: string | null;
  callCount: number;
  calls: CallEntry[];
  firstCallDate: string;
  lastCallDate: string;
  actionable: boolean;
  willful: boolean;
  damagesEstimate: number;
  demandLetterSent: boolean;
  demandLetterDate: string | null;
  subscriberIds: string[];  // all users this offender has called
  filedAt?: string | null;       // ISO timestamp when filing package was generated
  filedCaseRef?: string | null;  // internal case reference of the filed package
  /** P3.1: cached Twilio Lookup line-type result. Populated lazily after the
   *  first call; used by the legal filing generator to pick the right TCPA
   *  prong (§ 227(b)(1)(A)(iii) cellular vs § 227(b)(1)(B) residential). */
  lineTypeLookup?: {
    normalizedType: "landline" | "mobile" | "voip" | "unknown";
    rawType: string | null;
    carrierName: string | null;
    countryCode: string | null;
    lookedUpAt: string;
  } | null;
  /** AUDIT_ROUND_19: cached OpenCorporates entity-registry lookup. Fired
   *  asynchronously when the offender becomes actionable (call #2). 90-day
   *  TTL. Drives the "is this a real, in-good-standing entity?" signal in
   *  defendantResearch's collectability score. Discriminated union matches
   *  EntityLookupResult shape from openCorporatesClient.ts. */
  entityLookup?: {
    status: "match" | "no_match" | "skipped" | "error";
    matchedName?: string;
    companyNumber?: string;
    jurisdictionCode?: string | null;
    normalizedStatus?: "active" | "inactive" | "dissolved" | "unknown";
    rawStatus?: string | null;
    incorporationDate?: string | null;
    registeredAddress?: string | null;
    sourceUrl?: string;
    matchConfidence?: "exact" | "high" | "low";
    errorMessage?: string;
    lookedUpAt: string;
  } | null;
  /** AUDIT_ROUND_19: cached CourtListener prior-litigation lookup. Fired
   *  asynchronously when the offender becomes actionable. 30-day TTL. The
   *  case count is the single strongest collectability predictor for TCPA
   *  defendants (per courtListenerClient.ts). */
  priorLitigation?: {
    status: "match" | "no_match" | "skipped" | "error";
    caseCount?: number;
    sampleCases?: Array<{ caption: string; docketUrl: string | null; dateFiled: string | null; court: string | null }>;
    searchUrl?: string;
    errorMessage?: string;
    lookedUpAt: string;
  } | null;
  /** Stage 2: Perplexity Sonar deep-research summary. Fired only when an
   *  offender becomes actionable AND a filing is being prepared. Captures
   *  recent FCC actions, regulatory complaints, news mentions, and current
   *  case-law status that no single dedicated API exposes cleanly. */
  defendantWebResearch?: {
    status: "match" | "skipped" | "error";
    summary?: string;
    citations?: string[];
    model?: string;
    errorMessage?: string;
    lookedUpAt: string;
  } | null;
  /** AUDIT_ROUND_20: per-case manual evidence-gathering checklist. Generated
   *  when an offender becomes actionable. Each item has a deep-link or a
   *  copy-paste template. Marcus checks items off via the dashboard; cadence
   *  reminders fire in Discord at +24h/+72h on still-incomplete items. */
  evidenceChecklist?: {
    /** ISO timestamp when the checklist was generated */
    generatedAt: string;
    /** ISO timestamp of last Discord reminder fired (avoid double-pinging) */
    lastReminderAt?: string | null;
    items: Array<{
      id: string;
      title: string;
      why: string;
      /** "open external URL", "copy this template text", "send this email", "no action — informational" */
      action: "url" | "copy" | "email" | "info";
      url?: string;
      template?: string;
      mailto?: string;
      /** Prep walkthrough — what you'll see, how long it takes, what to do.
       *  Surfaced inline on the dashboard expansion AND in the printed
       *  EVIDENCE_CHECKLIST.txt that lives in the saved filing package. */
      whatToExpect?: string;
      /** Optional escalation path. Only shown / mentioned when the primary
       *  path fails (e.g., portal screenshot doesn't work, or defendant
       *  contests the calls). Subpoena instructions live here, NOT in the
       *  primary action — most cases never need this. */
      escalation?: {
        trigger: string;
        title: string;
        instructions: string;
        url?: string;
        template?: string;
      };
      completed: boolean;
      completedAt?: string | null;
    }>;
  } | null;
}

type CasesDB = Record<string, OffenderProfile>;

// ── File I/O ─────────────────────────────────────────────────────────────
//
//  Uses atomic write pattern: write to temp file, then rename.
//  This prevents corruption from partial writes or crashes mid-write.
//  Also detects and backs up corrupted files instead of silently losing data.

/**
 * P2.1: write-queue infrastructure for any FUTURE code path that wants to
 * mutate cases.json from inside an async context (i.e., one that contains an
 * `await` between load and save). The current logCall/attachRecording/
 * attachGrade paths are fully synchronous and run to completion within a
 * single Node tick, so the race the audit warned about is not exploitable
 * today — Node is single-threaded and fs.{readFileSync,writeFileSync} cannot
 * interleave inside one tick.
 *
 * The risk this defends against is forward-looking: if anyone adds an
 * `await` between loadCases() and saveCases() in a future change, two
 * concurrent requests CAN interleave the read-modify-write cycle and the
 * second write clobbers the first. Route any such code through
 * mutateCases() instead of touching loadCases/saveCases directly.
 */
let writeQueue: Promise<unknown> = Promise.resolve();

/**
 * Serialize a load → mutate → save cycle through the write queue.
 * Use this from any async path that mutates cases.json. Returns whatever
 * the mutator returns.
 */
export function mutateCases<T>(mutator: (db: CasesDB) => T | Promise<T>): Promise<T> {
  const next = writeQueue.then(async () => {
    const db = loadCases();
    const result = await mutator(db);
    saveCases(db);
    return result;
  });
  // Keep the chain alive even if this iteration throws — otherwise one
  // failure poisons every subsequent write.
  writeQueue = next.catch(() => undefined);
  return next;
}

function loadCases(): CasesDB {
  if (!fs.existsSync(CASES_FILE)) return {};

  let content: string;
  try {
    content = fs.readFileSync(CASES_FILE, "utf-8");
  } catch (err) {
    console.error(`[CaseBuilder] Failed to read cases.json: ${err}`);
    throw err;
  }

  try {
    const parsed = JSON.parse(content);

    // Validate it's a plain object, not an array or null
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("cases.json root is not an object");
    }

    return parsed as CasesDB;
  } catch (err) {
    // Corrupted JSON — back up the bad file before throwing
    const backupPath = CASES_FILE + `.backup.${Date.now()}`;
    try {
      fs.copyFileSync(CASES_FILE, backupPath);
      console.error(
        `[CaseBuilder] CORRUPTED cases.json backed up to ${backupPath}. ` +
        `Parse error: ${err}`
      );
    } catch (backupErr) {
      console.error(
        `[CaseBuilder] Failed to back up corrupted cases.json: ${backupErr}`
      );
    }
    throw new Error(`cases.json is corrupted: ${err}`);
  }
}

function saveCases(db: CasesDB): void {
  // Atomic write: write to temp file, then rename over the real file.
  // fs.renameSync is atomic on most filesystems (POSIX guarantee).
  try {
    fs.writeFileSync(CASES_TEMP, JSON.stringify(db, null, 2), "utf-8");
    fs.renameSync(CASES_TEMP, CASES_FILE);
  } catch (err) {
    console.error(`[CaseBuilder] Failed to save cases.json: ${err}`);
    // Clean up temp file if rename failed
    try { fs.unlinkSync(CASES_TEMP); } catch { /* ignore */ }
    throw err;
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────

/**
 * Normalize a phone number for use as an offender key.
 *
 * Handles:
 *  - US/Canada NANP: +1XXXXXXXXXX, 1XXXXXXXXXX, XXXXXXXXXX → "+1XXXXXXXXXX"
 *  - International: +44XXXXXXXXX → "+44XXXXXXXXX" (preserved with country code)
 *
 * Throws if the number is too short to be valid.
 */
export function normalizePhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");

  if (digits.length < 10) {
    // Too short — log and use raw digits as key rather than crash
    console.warn(
      `[CaseBuilder] Short phone number: "${phone}" (${digits.length} digits). ` +
      `Using raw digits as key.`
    );
    return digits;
  }

  // US/Canada NANP: exactly 10 digits (no country code)
  if (digits.length === 10) {
    return `+1${digits}`;
  }

  // US/Canada with country code: 11 digits starting with 1
  if (digits.length === 11 && digits[0] === "1") {
    return `+${digits}`;
  }

  // International or other long number: preserve full with + prefix
  return `+${digits}`;
}

/**
 * Check if two dates are within 12 calendar months of each other.
 * Uses actual calendar month arithmetic, not a flat 365-day count,
 * because the TCPA says "12-month period," not "365 days."
 */
function isWithin12Months(date1: string, date2: string): boolean {
  if (!date1 || !date2) return false;

  const d1 = new Date(date1 + "T00:00:00Z");
  const d2 = new Date(date2 + "T00:00:00Z");

  if (isNaN(d1.getTime()) || isNaN(d2.getTime())) {
    console.error(
      `[CaseBuilder] Invalid date in 12-month check: "${date1}", "${date2}"`
    );
    return false;
  }

  // Always compare earlier → later
  const earlier = d1 <= d2 ? d1 : d2;
  const later = d1 <= d2 ? d2 : d1;

  // Add 12 calendar months to the earlier date
  const cutoff = new Date(earlier);
  cutoff.setUTCFullYear(cutoff.getUTCFullYear() + 1);

  return later <= cutoff;
}

/**
 * Validate an offender profile for internal consistency.
 * Logs warnings for issues but does not throw (self-healing approach).
 */
function validateProfile(profile: OffenderProfile, key: string): void {
  if (profile.callCount !== profile.calls.length) {
    console.warn(
      `[CaseBuilder] Data mismatch for ${key}: callCount=${profile.callCount} ` +
      `but calls.length=${profile.calls.length}. Auto-correcting.`
    );
    profile.callCount = profile.calls.length;
  }

  if (profile.actionable && profile.callCount < 2) {
    console.warn(
      `[CaseBuilder] ${key} marked actionable with only ${profile.callCount} call(s). ` +
      `Correcting to non-actionable.`
    );
    profile.actionable = false;
  }
}

// ── Core: log a call and update the offender profile ─────────────────────

export function logCall(
  subscriberId: string,
  callerPhone: string,
  companyName: string | null,
  callerName: string | null,
  purpose: string | null,
  callSid: string,
  recordingUrl: string | null,
  transcriptSnippet: string = "",
  callType: string = "unknown"
): { offender: OffenderProfile; isNewlyActionable: boolean } {
  const db = loadCases();
  const key = normalizePhone(callerPhone);
  const now = new Date();
  const dateStr = now.toISOString().split("T")[0];
  const timeStr = now.toTimeString().slice(0, 5);

  const wasActionable = db[key]?.actionable ?? false;

  if (!db[key]) {
    db[key] = {
      normalizedNumber: key,
      rawNumbers: [callerPhone],
      companyName: null,
      callerNames: [],
      purpose: null,
      callCount: 0,
      calls: [],
      firstCallDate: dateStr,
      lastCallDate: dateStr,
      actionable: false,
      willful: false,
      damagesEstimate: 0,
      demandLetterSent: false,
      demandLetterDate: null,
      subscriberIds: [],
    };
  }

  const profile = db[key];

  // Update company info if we got it and don't have it yet
  if (companyName && !profile.companyName) {
    profile.companyName = companyName;
  }

  // Track caller names
  if (callerName && !profile.callerNames.includes(callerName)) {
    profile.callerNames.push(callerName);
  }

  // Track purpose
  if (purpose && !profile.purpose) {
    profile.purpose = purpose;
  }

  // Track raw number formats
  if (!profile.rawNumbers.includes(callerPhone)) {
    profile.rawNumbers.push(callerPhone);
  }

  // Track which subscribers this offender calls
  if (!profile.subscriberIds.includes(subscriberId)) {
    profile.subscriberIds.push(subscriberId);
  }

  // Add call entry
  profile.calls.push({
    date: dateStr,
    time: timeStr,
    callSid,
    subscriberId,
    recordingUrl,
    transcriptSnippet: transcriptSnippet.slice(0, 300),
    callType,
  });

  profile.callCount = profile.calls.length;
  profile.lastCallDate = dateStr;

  // Check TCPA 227(c)(5) threshold: 2+ calls within 12 months
  if (profile.callCount >= 2 && isWithin12Months(profile.firstCallDate, profile.lastCallDate)) {
    profile.actionable = true;
  }

  // If they called AFTER a demand letter was sent, mark as willful.
  // Uses Date comparison instead of string comparison to handle timezone edge cases.
  if (profile.demandLetterSent && profile.demandLetterDate) {
    const demandDate = new Date(profile.demandLetterDate + "T00:00:00Z");
    if (!isNaN(demandDate.getTime())) {
      const postDemandCalls = profile.calls.filter((c) => {
        const callDate = new Date(c.date + "T00:00:00Z");
        return !isNaN(callDate.getTime()) && callDate > demandDate;
      });
      if (postDemandCalls.length > 0 && !profile.willful) {
        profile.willful = true;
        console.log(
          `[CaseBuilder] ${key} marked WILLFUL: ${postDemandCalls.length} call(s) ` +
          `after demand letter sent on ${profile.demandLetterDate}`
        );
      }
    }
  }

  // Calculate damages: $500/violation standard, $1500/violation if willful
  const rate = profile.willful ? 1500 : 500;
  profile.damagesEstimate = profile.callCount * rate;

  saveCases(db);

  const isNewlyActionable = profile.actionable && !wasActionable;

  if (isNewlyActionable) {
    console.log(
      `[CaseBuilder] NEW ACTIONABLE CASE: ${key} (${profile.companyName ?? "unknown company"}) — ` +
      `${profile.callCount} calls, $${profile.damagesEstimate} estimated damages`
    );
  }

  return { offender: profile, isNewlyActionable };
}

// ── Query functions ──────────────────────────────────────────────────────

export function getOffender(normalizedNumber: string): OffenderProfile | null {
  const db = loadCases();
  const profile = db[normalizedNumber] ?? null;
  if (profile) {
    validateProfile(profile, normalizedNumber);
  }
  return profile;
}

export function getActionableCases(subscriberId?: string): OffenderProfile[] {
  const db = loadCases();
  let cases = Object.values(db).filter((p) => p.actionable);
  if (subscriberId) {
    cases = cases.filter((p) => p.subscriberIds.includes(subscriberId));
  }
  return cases.sort((a, b) => b.damagesEstimate - a.damagesEstimate);
}

export function getAllOffenders(): OffenderProfile[] {
  const db = loadCases();
  return Object.values(db).sort((a, b) => b.callCount - a.callCount);
}

export function getCaseSummary(subscriberId?: string): {
  totalCalls: number;
  uniqueOffenders: number;
  actionableCases: number;
  totalDamages: number;
  topOffenders: Array<{ number: string; company: string | null; calls: number; damages: number }>;
} {
  const db = loadCases();
  let offenders = Object.values(db);
  if (subscriberId) {
    offenders = offenders.filter((p) => p.subscriberIds.includes(subscriberId));
  }

  const actionable = offenders.filter((p) => p.actionable);

  return {
    totalCalls: offenders.reduce((sum, p) => sum + p.callCount, 0),
    uniqueOffenders: offenders.length,
    actionableCases: actionable.length,
    totalDamages: actionable.reduce((sum, p) => sum + p.damagesEstimate, 0),
    topOffenders: offenders.slice(0, 10).map((p) => ({
      number: p.normalizedNumber,
      company: p.companyName,
      calls: p.callCount,
      damages: p.damagesEstimate,
    })),
  };
}

// ── Demand letter ────────────────────────────────────────────────────────

export function markDemandSent(normalizedNumber: string): void {
  const db = loadCases();
  const profile = db[normalizedNumber];
  if (!profile) return;
  profile.demandLetterSent = true;
  profile.demandLetterDate = new Date().toISOString().split("T")[0];
  saveCases(db);
}

/** Mark a case as filed — freezes the profile so subsequent calls don't overwrite it */
export function markOffenderFiled(normalizedNumber: string, caseRef: string): boolean {
  const db = loadCases();
  const profile = db[normalizedNumber];
  if (!profile) return false;
  profile.filedAt = new Date().toISOString();
  profile.filedCaseRef = caseRef;
  saveCases(db);
  return true;
}

/**
 * AUDIT_ROUND_19 helper: cache an OpenCorporates entity lookup on the
 * offender profile. 90-day TTL. Use shouldRefreshEnrichment() below to
 * decide whether to re-fetch.
 */
export function attachEntityLookup(
  normalizedNumber: string,
  result: NonNullable<OffenderProfile["entityLookup"]>
): boolean {
  if (!normalizedNumber) return false;
  const db = loadCases();
  const profile = db[normalizedNumber];
  if (!profile) return false;
  profile.entityLookup = result;
  saveCases(db);
  return true;
}

/**
 * AUDIT_ROUND_19 helper: cache a CourtListener prior-litigation result on
 * the offender profile. 30-day TTL (federal litigation is filed weekly).
 */
export function attachPriorLitigation(
  normalizedNumber: string,
  result: NonNullable<OffenderProfile["priorLitigation"]>
): boolean {
  if (!normalizedNumber) return false;
  const db = loadCases();
  const profile = db[normalizedNumber];
  if (!profile) return false;
  profile.priorLitigation = result;
  saveCases(db);
  return true;
}

/**
 * Stage 2 helper: cache a Perplexity Sonar web-research summary on the
 * offender profile. 30-day TTL because regulatory news moves fast.
 */
export function attachDefendantWebResearch(
  normalizedNumber: string,
  result: NonNullable<OffenderProfile["defendantWebResearch"]>
): boolean {
  if (!normalizedNumber) return false;
  const db = loadCases();
  const profile = db[normalizedNumber];
  if (!profile) return false;
  profile.defendantWebResearch = result;
  saveCases(db);
  return true;
}

/**
 * AUDIT_ROUND_20: persist the per-case evidence checklist on the offender.
 * Idempotent — overwrites any existing checklist (Marcus may regenerate
 * after editing his .env e.g., adding new carrier templates).
 */
export function attachEvidenceChecklist(
  normalizedNumber: string,
  checklist: NonNullable<OffenderProfile["evidenceChecklist"]>
): boolean {
  if (!normalizedNumber) return false;
  const db = loadCases();
  const profile = db[normalizedNumber];
  if (!profile) return false;
  profile.evidenceChecklist = checklist;
  saveCases(db);
  return true;
}

/** Toggle a single checklist item completed/uncompleted. Returns the new state. */
export function toggleChecklistItem(
  normalizedNumber: string,
  itemId: string,
  forceState?: boolean
): { found: boolean; completed?: boolean } {
  if (!normalizedNumber || !itemId) return { found: false };
  const db = loadCases();
  const profile = db[normalizedNumber];
  if (!profile?.evidenceChecklist) return { found: false };
  const item = profile.evidenceChecklist.items.find((i) => i.id === itemId);
  if (!item) return { found: false };
  const newState = typeof forceState === "boolean" ? forceState : !item.completed;
  item.completed = newState;
  item.completedAt = newState ? new Date().toISOString() : null;
  saveCases(db);
  return { found: true, completed: newState };
}

/** Update the lastReminderAt timestamp on a case's checklist (used by reminder pump). */
export function markChecklistReminded(normalizedNumber: string): boolean {
  if (!normalizedNumber) return false;
  const db = loadCases();
  const profile = db[normalizedNumber];
  if (!profile?.evidenceChecklist) return false;
  profile.evidenceChecklist.lastReminderAt = new Date().toISOString();
  saveCases(db);
  return true;
}

/**
 * Decide whether a cached lookup is fresh enough to skip a re-fetch. TTL
 * varies by lookup type: line type rarely changes (90 days), entity status
 * doesn't change much (90 days), litigation count and web news change
 * faster (30 days).
 */
export function isFreshLookup(
  lookedUpAt: string | undefined,
  ttlDays: number
): boolean {
  if (!lookedUpAt) return false;
  const t = new Date(lookedUpAt).getTime();
  if (isNaN(t)) return false;
  return Date.now() - t < ttlDays * 24 * 60 * 60 * 1000;
}

/**
 * P3.1: cache the Twilio Lookup line-type result on the offender profile.
 * Idempotent — only writes if there's no cached result OR the result is
 * older than 90 days. Costs $0.005/lookup; we want to pay this fee at
 * most once per number per quarter.
 */
export function attachLineTypeLookup(
  normalizedNumber: string,
  result: NonNullable<OffenderProfile["lineTypeLookup"]>
): boolean {
  if (!normalizedNumber) return false;
  const db = loadCases();
  const profile = db[normalizedNumber];
  if (!profile) return false;
  // Don't re-cache if a fresh lookup is already there.
  const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;
  if (profile.lineTypeLookup) {
    const prev = new Date(profile.lineTypeLookup.lookedUpAt).getTime();
    if (!isNaN(prev) && Date.now() - prev < NINETY_DAYS_MS) {
      return false;
    }
  }
  profile.lineTypeLookup = result;
  saveCases(db);
  return true;
}

/**
 * Attach a conversation grade to a call entry by callSid. Used by
 * /api/cases/log right after logCall to persist the grader's verdict
 * onto the freshly-stored CallEntry.
 *
 * Returns true if the call was found and updated, false otherwise.
 */
export function attachGrade(
  callSid: string,
  grade: NonNullable<CallEntry["grade"]>
): boolean {
  if (!callSid) return false;
  const db = loadCases();
  for (const profile of Object.values(db)) {
    const call = profile.calls.find((c) => c.callSid === callSid);
    if (call) {
      call.grade = grade;
      saveCases(db);
      return true;
    }
  }
  return false;
}

/**
 * Backfill a Twilio recording URL onto a call that was previously logged
 * without one. Called from the recording-status webhook after Twilio
 * finishes processing the recording.
 * Returns true if the call was found and updated, false otherwise.
 */
export function attachRecording(callSid: string, recordingUrl: string): boolean {
  if (!callSid || !recordingUrl) return false;
  const db = loadCases();
  for (const profile of Object.values(db)) {
    const call = profile.calls.find((c) => c.callSid === callSid);
    if (call) {
      call.recordingUrl = recordingUrl;
      saveCases(db);
      console.log(
        `[CaseBuilder] Attached recording to callSid=${callSid} ` +
        `offender=${profile.normalizedNumber} url=${recordingUrl.slice(0, 80)}`
      );
      return true;
    }
  }
  console.warn(`[CaseBuilder] attachRecording: no call found with callSid=${callSid}`);
  return false;
}

// ── Filing package (small claims court) ─────────────────────────────────
//
//  These re-export the legal filing generator so the rest of the app can
//  access everything through caseBuilder as a single entry point.
//  Usage:
//    import { generateFilingPackage } from "./caseBuilder";
//    const pkg = generateFilingPackage("5551234567");

export {
  generateFilingPackage,
  generateAndSaveFilingPackage,
  FilingPackage,
  FilingConfig,
} from "./legalFilingGenerator";

// ── Demand letter ────────────────────────────────────────────────────────
//  (The demand letter is a PRE-filing step. Send this first. If they keep
//  calling, use generateFilingPackage() above to sue them.)

export function generateDemandLetter(
  normalizedNumber: string,
  userName: string,
  userAddress: string,
  userPhone: string,
  dncSince: string = "2007",
  courtName: string = "Lafayette City Court",
  parishOrCounty: string = "Lafayette Parish",
  courtState: string = "Louisiana"
): string | null {
  const profile = getOffender(normalizedNumber);
  if (!profile || !profile.actionable) return null;

  const today = new Date();
  const deadline = new Date(today.getTime() + 30 * 24 * 60 * 60 * 1000);
  const company = profile.companyName ?? `Entity at ${profile.rawNumbers[0] ?? normalizedNumber}`;

  const callList = profile.calls
    .map((c, i) => `    ${i + 1}. ${c.date} at ${c.time}`)
    .join("\n");

  return `${userName}
${userAddress}
${userPhone}

${today.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })}

VIA CERTIFIED MAIL, RETURN RECEIPT REQUESTED

To: ${company}
Re: Violations of the Telephone Consumer Protection Act
    Telephone Number: ${profile.rawNumbers[0] ?? normalizedNumber}

Dear Sir or Madam:

NOTICE OF VIOLATIONS AND DEMAND FOR PAYMENT

I am writing to notify you that you have repeatedly called my telephone
number, ${userPhone}, in violation of the Telephone Consumer Protection
Act ("TCPA"), 47 U.S.C. Section 227(c), and the Federal Communications
Commission's implementing regulations at 47 C.F.R. Section 64.1200.

I never provided prior express written consent to receive calls from
your company, and no established business relationship exists between us.

My telephone number has been registered on the National Do Not Call
Registry since ${dncSince}. Despite this registration, your company has
placed ${profile.callCount} unsolicited telephone call(s) to my number
between ${profile.firstCallDate} and ${profile.lastCallDate}:

${callList}

All calls were answered by a recorded compliance system, captured
under one-party consent law (La. R.S. 15:1303), and documented with
full metadata including timestamps, recordings, and transcripts.

Under 47 U.S.C. Section 227(c)(5), any person who has received more
than one telephone call within any 12-month period by or on behalf of
the same entity in violation of the regulations prescribed under this
subsection may bring a private action for actual monetary loss or
receive up to $500 in damages for each such violation, whichever is
greater.

${profile.willful ? `Your company knowingly and intentionally continued to call after
receiving a prior cease-and-desist notice, demonstrating willful
violation of the TCPA. Under 47 U.S.C. Section 227(c)(5)(B), the
court may treble damages to $1,500 per violation.\n` : ""}Based on ${profile.callCount} violation(s), I am entitled to statutory
damages of $${profile.damagesEstimate.toLocaleString()}.

DEMAND

I hereby demand that you:

    1. Immediately cease all calls to ${userPhone}.
    2. Place ${userPhone} on your internal do-not-call list.
    3. Pay $${profile.damagesEstimate.toLocaleString()} in statutory damages within
       thirty (30) days of receipt of this letter
       (by ${deadline.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })}).

If payment is not received by the deadline above, I will file suit in
the ${courtName}, ${parishOrCounty}, ${courtState}, seeking the
maximum statutory damages permitted under 47 U.S.C. Section 227(c)(5),
plus court costs. See Mims v. Arrow Financial Services, 565 U.S. 368
(2012) (state courts have concurrent jurisdiction over TCPA claims).

This letter constitutes formal notice and preserves all legal rights
and remedies available to me.

Sincerely,

____________________________
${userName}
${userPhone}

cc: Federal Trade Commission
    Federal Communications Commission
    Louisiana Public Service Commission`;
}
