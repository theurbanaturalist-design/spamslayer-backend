// ─────────────────────────────────────────────────────────────────────────────
//  caseBuilder.ts — TCPA case tracking across calls and users
//
//  Tracks every offender (by normalized phone number), counts violations,
//  flags cases as actionable when they hit the 2-call TCPA threshold,
//  calculates damages, and generates demand letters.
//
//  Storage: in-memory CasesDB, loaded from Supabase on startup and
//  async-synced back after every mutation. Survives container restarts
//  and Render redeployments (no ephemeral filesystem dependency).
//
//  Required Supabase table (run once in your Supabase SQL editor):
//    CREATE TABLE spam_cases_store (
//      key text PRIMARY KEY,
//      data jsonb NOT NULL DEFAULT '{}',
//      updated_at timestamptz DEFAULT now()
//    );
//    ALTER TABLE spam_cases_store DISABLE ROW LEVEL SECURITY;
// ─────────────────────────────────────────────────────────────────────────────

import { createClient, SupabaseClient } from "@supabase/supabase-js";

// ── Types ────────────────────────────────────────────────────────────────

export interface CallEntry {
  date: string;
  time: string;
  callSid: string;
  subscriberId: string;
  recordingUrl: string | null;
  transcriptSnippet: string;
  callType: string;
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
  // When a filing package has been generated for this case, we freeze the
  // profile so subsequent calls or manual edits do not silently diverge
  // the in-memory state from what the court has on file. The filing
  // package holds its own snapshot; further calls are tracked on a
  // post-filing continuation profile — see logCall() for the routing
  // of calls arriving after filedAt to `${normalized}#post-filed`.
  filedAt?: string | null;          // ISO timestamp when package was generated
  filedCaseRef?: string | null;     // internal case reference of the filed package
}

type CasesDB = Record<string, OffenderProfile>;

// ── Supabase persistence ──────────────────────────────────────────────────
//
//  Cases live in-memory for fast synchronous access.
//  After every mutation, the full DB is async-upserted to Supabase so it
//  survives container restarts and Render redeployments.
//  On startup, call initCaseDb() to restore state from Supabase.

const SUPABASE_TABLE = "spam_cases_store";
const SUPABASE_ROW_KEY = "db";

let _supabase: SupabaseClient | null = null;
function getSupabase(): SupabaseClient | null {
  if (!_supabase) {
    const url = process.env.SUPABASE_URL ?? "";
    const key = process.env.SUPABASE_ANON_KEY ?? "";
    if (url && key) _supabase = createClient(url, key);
  }
  return _supabase;
}

// In-memory database — all reads/writes use this; Supabase is the durable store
let casesDb: CasesDB = {};

/**
 * Load the cases database from Supabase on startup.
 * Call once before the server starts accepting requests.
 */
export async function initCaseDb(): Promise<void> {
  const sb = getSupabase();
  if (!sb) {
    console.warn("[CaseBuilder] SUPABASE_URL/SUPABASE_ANON_KEY not set — cases stored in-memory only (lost on restart)");
    return;
  }
  const { data, error } = await sb
    .from(SUPABASE_TABLE)
    .select("data")
    .eq("key", SUPABASE_ROW_KEY)
    .maybeSingle();
  if (error) {
    console.error("[CaseBuilder] Failed to load cases from Supabase:", error.message);
    return;
  }
  if (data?.data) {
    casesDb = data.data as CasesDB;
    console.log(`[CaseBuilder] Restored ${Object.keys(casesDb).length} offender(s) from Supabase`);
  } else {
    console.log("[CaseBuilder] No existing cases in Supabase — starting fresh");
  }
}

function loadCases(): CasesDB {
  return casesDb;
}

function saveCases(db: CasesDB): void {
  casesDb = db;
  // Async upsert to Supabase — fire-and-forget, never blocks a call
  const sb = getSupabase();
  if (sb) {
    sb.from(SUPABASE_TABLE)
      .upsert({ key: SUPABASE_ROW_KEY, data: db, updated_at: new Date().toISOString() })
      .then(
        ({ error }) => {
          if (error) console.error("[CaseBuilder] Supabase sync failed:", error.message);
        },
        (err: Error) => console.error("[CaseBuilder] Supabase sync error:", err.message)
      );
  }
}

/**
 * Synchronous in-memory read-modify-write. Node's single-threaded event loop
 * guarantees no interleaving between the loadCases() and saveCases() calls
 * as long as fn() contains no awaits (which it doesn't).
 */
function mutateCasesSync<T>(fn: (db: CasesDB) => T): T {
  const db = loadCases();
  const result = fn(db);
  saveCases(db);
  return result;
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
 *
 * IMPORTANT: This must use the SAME algorithm as
 * legalFilingGenerator.ts's sliding-window validator — setUTCMonth(+12),
 * not setUTCFullYear(+1). setUTCFullYear(+1) on Feb 29 of a leap year
 * produces different behavior (JavaScript rolls to Mar 1 of the next
 * year because Feb 29 doesn't exist). setUTCMonth(+12) and
 * setUTCFullYear(+1) diverge on leap-year boundary dates. Unifying on
 * the filing generator's algorithm prevents caseBuilder flagging a
 * case as actionable that the filing generator then rejects.
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

  // Add 12 calendar months to the earlier date. Uses setUTCMonth(+12)
  // to match legalFilingGenerator.ts — both files must use identical
  // algorithm or an edge-date case will be flagged actionable in one
  // and rejected in the other.
  const cutoff = new Date(earlier);
  cutoff.setUTCMonth(cutoff.getUTCMonth() + 12);

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
  // All mutations go through mutateCasesSync so concurrent webhooks don't
  // clobber each other with stale reads.
  return mutateCasesSync((db) => {
    const key = normalizePhone(callerPhone);
    const now = new Date();
    const dateStr = now.toISOString().split("T")[0];
    const timeStr = now.toTimeString().slice(0, 5);

    // Create profile on first contact with this number.
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
        filedAt: null,
        filedCaseRef: null,
      };
    }

    // Determine which profile to write this call onto. If the primary
    // profile has been filed (a filing package was generated), freeze it
    // and append the new call to a continuation profile instead.
    let targetKey = key;
    if (db[key].filedAt) {
      const continuationKey = `${key}#post-filed`;
      if (!db[continuationKey]) {
        db[continuationKey] = {
          normalizedNumber: continuationKey,
          rawNumbers: [callerPhone],
          companyName: db[key].companyName,
          callerNames: [],
          purpose: db[key].purpose,
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
          filedAt: null,
          filedCaseRef: null,
        };
      }
      console.warn(
        `[CaseBuilder] ${key} was filed on ${db[key].filedAt} (ref ${db[key].filedCaseRef}). ` +
        `Routing new call to continuation profile ${continuationKey}.`
      );
      targetKey = continuationKey;
    }

    const profile = db[targetKey];
    const wasActionable = profile.actionable;

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
            `[CaseBuilder] ${targetKey} marked WILLFUL: ${postDemandCalls.length} call(s) ` +
            `after demand letter sent on ${profile.demandLetterDate}`
          );
        }
      }
    }

    // Calculate damages. Under 47 U.S.C. § 227(c)(5), willful/knowing
    // violations are subject to trebled damages ($1,500) — but trebling
    // only applies to calls that were themselves willful, i.e. those
    // placed AFTER the defendant had notice to stop. A demand letter is
    // the clearest form of such notice. Calls BEFORE the demand letter
    // are ordinary violations at $500. Applying $1,500 to every call
    // just because one post-demand call exists inflates the prayer and
    // invites a defense challenge that could wipe out the treble claim.
    const standardRate = 500;
    const willfulRate = 1500;
    if (profile.willful && profile.demandLetterSent && profile.demandLetterDate) {
      const demandDate = new Date(profile.demandLetterDate + "T00:00:00Z");
      if (!isNaN(demandDate.getTime())) {
        let preDemandCalls = 0;
        let postDemandCalls = 0;
        for (const c of profile.calls) {
          const callDate = new Date(c.date + "T00:00:00Z");
          if (!isNaN(callDate.getTime()) && callDate > demandDate) {
            postDemandCalls++;
          } else {
            preDemandCalls++;
          }
        }
        profile.damagesEstimate =
          preDemandCalls * standardRate + postDemandCalls * willfulRate;
      } else {
        // Demand date unparseable — fall back to the conservative
        // calculation (all calls at the standard rate).
        profile.damagesEstimate = profile.callCount * standardRate;
      }
    } else {
      profile.damagesEstimate = profile.callCount * standardRate;
    }

    // mutateCasesSync persists the db after this function returns.

    const isNewlyActionable = profile.actionable && !wasActionable;

    if (isNewlyActionable) {
      console.log(
        `[CaseBuilder] NEW ACTIONABLE CASE: ${targetKey} (${profile.companyName ?? "unknown company"}) — ` +
        `${profile.callCount} calls, $${profile.damagesEstimate} estimated damages`
      );
    }

    return { offender: profile, isNewlyActionable };
  });
}

/**
 * Mark an offender as "filed" so subsequent calls roll onto a continuation
 * profile and the original remains frozen. Called by the filing generator
 * immediately after a filing package is produced.
 */
export function markOffenderFiled(
  normalizedNumber: string,
  caseRef: string
): OffenderProfile | null {
  return mutateCasesSync((db) => {
    const profile = db[normalizedNumber];
    if (!profile) return null;
    // Idempotent: if already filed, leave the original timestamp/ref in
    // place (first-file wins) and just log.
    if (profile.filedAt) {
      console.warn(
        `[CaseBuilder] ${normalizedNumber} was already filed on ${profile.filedAt} ` +
        `(ref ${profile.filedCaseRef}). Ignoring new filing ref ${caseRef}.`
      );
      return profile;
    }
    profile.filedAt = new Date().toISOString();
    profile.filedCaseRef = caseRef;
    console.log(
      `[CaseBuilder] FROZE offender ${normalizedNumber} at filing (${caseRef}). ` +
      `Subsequent calls will route to a continuation profile.`
    );
    return profile;
  });
}

/**
 * Attach a recording URL to an existing call entry identified by callSid.
 * Called asynchronously when Twilio's recording-status callback arrives —
 * which happens after the call has already been logged in the case file.
 *
 * Searches all offender profiles (including post-filed continuations) for a
 * call with a matching callSid and sets its recordingUrl.
 *
 * Returns true if a matching call was found and updated, false otherwise.
 */
export function attachRecording(callSid: string, recordingUrl: string): boolean {
  if (!callSid || !recordingUrl) return false;
  return mutateCasesSync((db) => {
    for (const profile of Object.values(db)) {
      const call = profile.calls.find((c) => c.callSid === callSid);
      if (call) {
        call.recordingUrl = recordingUrl;
        console.log(
          `[CaseBuilder] Attached recording to callSid=${callSid} ` +
          `offender=${profile.normalizedNumber} url=${recordingUrl.slice(0, 80)}`
        );
        return true;
      }
    }
    console.warn(`[CaseBuilder] attachRecording: no call found with callSid=${callSid}`);
    return false;
  });
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
  // M1 (AUDIT_ROUND_15): also filter out continuation profiles so the
  // "ready to file" list on the Dashboard doesn't mix up a fresh case
  // and a post-filing continuation, which have different filing semantics.
  const db = loadCases();
  let cases = Object.entries(db)
    .filter(([key, p]) => p.actionable && !key.includes("#post-filed"))
    .map(([, p]) => p);
  if (subscriberId) {
    cases = cases.filter((p) => p.subscriberIds.includes(subscriberId));
  }
  return cases.sort((a, b) => b.damagesEstimate - a.damagesEstimate);
}

// M1 (AUDIT_ROUND_15): continuation profiles for already-filed offenders
// live under the key `${normalizedNumber}#post-filed`. They represent calls
// that arrived AFTER we filed on the parent — relevant for a second suit
// but confusing to show in the main Dashboard alongside first-time cases.
// getAllOffenders() now hides them by default. To inspect them explicitly,
// call getAllOffendersIncludingContinuations() or getContinuations().
export function getAllOffenders(): OffenderProfile[] {
  const db = loadCases();
  return Object.entries(db)
    .filter(([key]) => !key.includes("#post-filed"))
    .map(([, p]) => p)
    .sort((a, b) => b.callCount - a.callCount);
}

export function getAllOffendersIncludingContinuations(): OffenderProfile[] {
  const db = loadCases();
  return Object.values(db).sort((a, b) => b.callCount - a.callCount);
}

export function getContinuations(): OffenderProfile[] {
  const db = loadCases();
  return Object.entries(db)
    .filter(([key]) => key.includes("#post-filed"))
    .map(([, p]) => p)
    .sort((a, b) => b.callCount - a.callCount);
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

// ── Case strength meter ─────────────────────────────────────────────────
//  Evaluate case viability before filing. Returns a score 0-100 and a
//  rating (STRONG / MODERATE / WEAK / NOT_READY).

export {
  evaluateCaseStrength,
  formatCaseStrengthReport,
  CaseStrengthReport,
  CaseRating,
} from "./caseStrengthMeter";

// ── Evidence integrity (cryptographic signing) ──────────────────────────
//  SHA-256 hash recordings at capture time for chain-of-custody proof.

export {
  signEvidence,
  loadSignature,
  generateIntegrityCertificate,
  EvidenceSignature,
  IntegrityCertificate,
} from "./evidenceIntegrity";

// ── PDF filing generator ────────────────────────────────────────────────
//  Court-ready PDFs with proper formatting, margins, and page numbers.

export {
  generateFilingPdfs,
  PdfFilingResult,
} from "./filingPdfGenerator";

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
