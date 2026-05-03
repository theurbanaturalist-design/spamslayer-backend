// ─────────────────────────────────────────────────────────────────────────────
//  legalFilingGenerator.ts — Small claims court filing package generator
//
//  Bolts onto caseBuilder.ts to take an actionable TCPA case and produce
//  everything a user needs to file in small claims court:
//
//    1. Small claims petition (formatted for Louisiana City Court)
//    2. Evidence exhibit list (recordings, transcripts, call logs, DNC proof)
//    3. Certificate of service
//    4. Plain-English filing guide (step-by-step instructions)
//
//  The user's only job: print, sign, and file. We do the rest.
//
//  LEGAL REVIEW NOTES (April 2026):
//  - Verified against 47 U.S.C. § 227(c)(5) and 47 C.F.R. § 64.1200(c)
//  - Includes preemptive safe harbor, EBR, and consent defenses
//  - Includes statute of limitations check (4-year federal SOL)
//  - Dual-theory: alleges both § 227(c)(5) DNC + § 227(b) robocall where applicable
//  - Louisiana-specific: La. R.S. 45:844.14, La. R.S. 15:1303, La. R.S. 13:5200 et seq.
// ─────────────────────────────────────────────────────────────────────────────

import { OffenderProfile, CallEntry, getOffender, markOffenderFiled, normalizePhone } from "./caseBuilder";
import { evaluateCaseStrength } from "./caseStrengthMeter";
import { loadSignaturesForNumber } from "./evidenceIntegrity";
import { generateDefendantResearchReport } from "./defendantResearch";
import { generateComplaintBundle, ComplaintBundle } from "./complaintBundle";
import { auditTextBlobs, AuditReport } from "./citationAudit";
import crypto from "crypto";
import fs from "fs";
import path from "path";

// ── Filing config (loaded from phone.json or defaults) ──────────────────

// Anchor phone.json path to this module's location (not process.cwd()) so the
// path is stable regardless of which directory the server is started from.
// The backend/ directory is 3 levels up from src/services/. phone.json lives
// at the repo root (one level above backend/).
const PHONE_CONFIG_PATH = (() => {
  const fromModule = path.resolve(__dirname, "..", "..", "..", "phone.json");
  if (fs.existsSync(fromModule)) return fromModule;
  // Fallback: cwd (legacy). Log a warning at load time so mis-rooted runs are
  // visible rather than silently falling back to defaults.
  const fromCwd = path.resolve(process.cwd(), "phone.json");
  if (fs.existsSync(fromCwd)) {
    // eslint-disable-next-line no-console
    console.warn(
      `[legalFilingGenerator] phone.json not found at module-anchored path ${fromModule}; ` +
      `falling back to cwd path ${fromCwd}. This is brittle — please move or symlink.`
    );
    return fromCwd;
  }
  return fromModule; // will surface as file-missing in loadFilingConfig
})();

export interface FilingConfig {
  // User info (required for filings)
  userName: string;
  userAddress: string;
  userCity: string;
  userState: string;
  userZip: string;
  userPhone: string;
  userEmail: string;

  // Court info
  courtName: string;        // e.g. "Lafayette City Court"
  courtAddress: string;
  courtCity: string;
  courtState: string;
  courtZip: string;
  courtClerkPhone: string;
  parishOrCounty: string;   // e.g. "Lafayette Parish"

  // DNC registration
  dncRegistrationDate: string;  // e.g. "2007-03-15" (YYYY-MM-DD preferred)

  // Filing fees (varies by jurisdiction)
  filingFee: string;         // e.g. "$75.00"
  serviceFee: string;        // e.g. "$25.00" for certified mail

  // State-specific
  stateDncStatute: string;        // e.g. "La. R.S. 45:844.14"
  stateRecordingLaw: string;      // e.g. "La. R.S. 15:1303 (one-party consent)"
  smallClaimsLimit: string;       // e.g. "$5,000"
  smallClaimsStatute: string;     // e.g. "La. R.S. 13:5200 et seq."

  // H4 (AUDIT_ROUND_15): line-type gate. The petition makes a sworn
  // "residential primary use" assertion; we must NOT make that assertion
  // unless the user has affirmatively told us the line is residential.
  //   "residential" — standard DNC petition under § 227(c)/§ 227(b)(1)(B)
  //   "cellular"    — petition pleads § 227(b)(1)(A)(iii) instead
  //   "mixed"       — primarily residential, incidental business use;
  //                   primary-use paragraph applies with extra hedging.
  //   "unspecified" — caller/user has not confirmed; filing must NOT
  //                   swear to residential status. A warning is added.
  lineType: "residential" | "cellular" | "mixed" | "unspecified";
}

// Default config for Lafayette, Louisiana — user can override in phone.json
const DEFAULT_FILING_CONFIG: FilingConfig = {
  userName: "[YOUR NAME]",
  userAddress: "[YOUR ADDRESS]",
  userCity: "Lafayette",
  userState: "LA",
  userZip: "[YOUR ZIP]",
  userPhone: "[YOUR PHONE]",
  userEmail: "[YOUR EMAIL]",

  courtName: "Lafayette City Court",
  courtAddress: "800 S. Buchanan Street",
  courtCity: "Lafayette",
  courtState: "LA",
  courtZip: "70501",
  courtClerkPhone: "(337) 291-8760",
  parishOrCounty: "Lafayette Parish",

  dncRegistrationDate: "2007",

  filingFee: "$75.00",
  serviceFee: "$25.00",

  stateDncStatute: "La. R.S. 45:844.14",
  stateRecordingLaw: "La. R.S. 15:1303 (one-party consent)",
  smallClaimsLimit: "$5,000",
  smallClaimsStatute: "La. R.S. 13:5200 et seq.",
  lineType: "unspecified",
};

function loadFilingConfig(): FilingConfig {
  // Distinguish "file missing" (acceptable — fall back to defaults so the
  // user can see what the placeholders look like) from "file exists but is
  // corrupt" (NOT acceptable — silently continuing with defaults would
  // produce filings using "[YOUR NAME]" without the user noticing).
  let raw: unknown;
  try {
    const text = fs.readFileSync(PHONE_CONFIG_PATH, "utf-8");
    try {
      raw = JSON.parse(text);
    } catch (parseErr) {
      // JSON is malformed. This MUST be loud — users will lose cases if
      // they file with placeholder values because a typo broke their JSON.
      const msg = parseErr instanceof Error ? parseErr.message : String(parseErr);
      throw new Error(
        `[LegalFiling] phone.json is not valid JSON (${msg}). ` +
        `Fix the file at ${PHONE_CONFIG_PATH} before generating filings. ` +
        `Common causes: trailing commas, unquoted keys, unescaped quotes.`
      );
    }
  } catch (readErr) {
    // If we already wrapped a parse error above, re-throw it verbatim.
    if (readErr instanceof Error && readErr.message.startsWith("[LegalFiling]")) {
      throw readErr;
    }
    // File missing / unreadable — acceptable fallback, but log clearly.
    console.warn(
      `[LegalFiling] phone.json not found or unreadable at ${PHONE_CONFIG_PATH}. ` +
      `Using placeholder defaults; filings generated in this state will fail ` +
      `validateFilingConfig() unless you create the file.`
    );
    return { ...DEFAULT_FILING_CONFIG };
  }

  if (typeof raw !== "object" || raw === null) {
    throw new Error(
      `[LegalFiling] phone.json must be a JSON object at its root, got ${typeof raw}. ` +
      `Fix the file at ${PHONE_CONFIG_PATH} before generating filings.`
    );
  }

  const filingConfig = (raw as { filingConfig?: unknown }).filingConfig;
  if (filingConfig !== undefined && (typeof filingConfig !== "object" || filingConfig === null)) {
    throw new Error(
      `[LegalFiling] phone.json "filingConfig" must be an object, got ${typeof filingConfig}. ` +
      `Fix the file at ${PHONE_CONFIG_PATH} before generating filings.`
    );
  }

  const merged = { ...DEFAULT_FILING_CONFIG, ...(filingConfig ?? {}) } as FilingConfig;
  // H4: normalize lineType. Any unknown string becomes "unspecified" so we
  // never accidentally swear to a category the user didn't confirm.
  const allowedLineTypes = new Set(["residential", "cellular", "mixed", "unspecified"]);
  if (!allowedLineTypes.has(merged.lineType as string)) {
    merged.lineType = "unspecified";
  }
  return merged;
}

/**
 * Validate that critical filing config fields are not still placeholders.
 * Throws if the user hasn't filled in their info yet.
 */
function validateFilingConfig(config: FilingConfig): void {
  const placeholders = ["[YOUR NAME]", "[YOUR ADDRESS]", "[YOUR ZIP]", "[YOUR PHONE]", "[YOUR EMAIL]"];
  const criticalFields: (keyof FilingConfig)[] = ["userName", "userAddress", "userZip", "userPhone", "userEmail"];

  for (const field of criticalFields) {
    if (placeholders.includes(config[field])) {
      throw new Error(
        `[LegalFiling] Missing required config: filingConfig.${field} ` +
        `is still a placeholder ("${config[field]}"). ` +
        `Update the filingConfig section in phone.json before generating filings.`
      );
    }
  }

  // Coerce all config fields to strings — phone.json may have numbers
  // (e.g., filingFee: 75 instead of "$75.00") which would crash .replace()
  for (const key of Object.keys(config) as (keyof FilingConfig)[]) {
    const val = config[key];
    if (typeof val !== "string") {
      (config as unknown as Record<string, string>)[key] = String(val ?? "");
    }
  }

  // Sanitize all config string fields — strip newlines, control characters,
  // Unicode bidi overrides and zero-width format chars. Without this, a
  // court-address field containing U+202E could silently reverse the
  // displayed street address, and the filer swears to a mis-rendered
  // address under penalty of perjury.
  for (const key of Object.keys(config) as (keyof FilingConfig)[]) {
    const val = config[key];
    if (typeof val === "string") {
      (config as unknown as Record<string, string>)[key] = val
        .replace(/[\r\n]+/g, " ")
        .replace(/[\x00-\x1f]/g, "")
        .replace(/[\u200B-\u200F\u202A-\u202E\u2066-\u2069]/g, "")
        .trim();
    }
  }

  // PT5 (AUDIT_ROUND_16): the DNC registration date is the hinge of every
  // § 227(c)(5) claim — the plaintiff has to prove "more than 31 days
  // prior to the calls at issue" (47 C.F.R. § 64.1200(c)(2)). If the user
  // types a bare year ("2007") into Settings, the petition will recite
  // that year in a sworn verification paragraph. A defendant then cross-
  // examines: "Mr. Smith, can you tell the court which day in 2007?" and
  // the 31-day element is impeached. Require YYYY-MM-DD, explicitly.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(config.dncRegistrationDate)) {
    throw new Error(
      `[LegalFiling] filingConfig.dncRegistrationDate must be in YYYY-MM-DD ` +
      `format (got "${config.dncRegistrationDate}"). The TCPA § 227(c)(5) ` +
      `private right of action requires proof that the plaintiff was on the ` +
      `DNC Registry at least 31 days before the first call at issue — a ` +
      `bare year is not enough for that proof. Open Settings → Legal and ` +
      `enter the precise registration date. If you don't know it, look it ` +
      `up at https://www.donotcall.gov/verify/verify.aspx before filing.`
    );
  }
  // Also validate the date is real (not e.g. 2026-02-31) and not in the future.
  {
    const d = new Date(config.dncRegistrationDate + "T00:00:00Z");
    if (isNaN(d.getTime())) {
      throw new Error(
        `[LegalFiling] filingConfig.dncRegistrationDate "${config.dncRegistrationDate}" ` +
        `is not a real calendar date.`
      );
    }
    const nowUtc = new Date();
    if (d.getTime() > nowUtc.getTime()) {
      throw new Error(
        `[LegalFiling] filingConfig.dncRegistrationDate "${config.dncRegistrationDate}" ` +
        `is in the future. Set it to the actual date you registered on the ` +
        `National Do Not Call Registry.`
      );
    }
  }
}

// ── Types for the filing package ────────────────────────────────────────

export interface FilingPackage {
  petition: string;
  exhibitList: string;
  certificateOfService: string;
  filingGuide: string;
  /**
   * AUDIT_ROUND_18: pre-filing defendant research + collectability checklist.
   * Generated by defendantResearch.ts. The user is expected to read this
   * report BEFORE signing the petition verification — a judgment you cannot
   * collect (offshore boiler room, dissolved shell, spoofed caller ID) is
   * worse than no judgment at all.
   */
  defendantResearch: string;
  collectabilityScore: number;                  // 0–100, higher = better
  collectabilityBand: "LOW" | "MEDIUM" | "HIGH";
  /**
   * R20: "File Everywhere" lawful-pressure complaint bundle. Contains draft
   * complaints to ITG, FCC, FTC DNC, State AG, BBB, and CFPB (each gated on
   * its threshold condition — see complaintBundle.ts). These are DRAFTS the
   * user reviews and submits manually; nothing is auto-filed.
   */
  complaintBundle: ComplaintBundle;
  caseNumber: string;         // internal reference, not court-assigned
  generatedDate: string;
  offenderNumber: string;
  damagesRequested: number;
  warnings: string[];         // any legal warnings (SOL, etc.)
}

// ── Internal helpers ────────────────────────────────────────────────────

function formatDate(dateStr: string): string {
  try {
    // Use UTC parsing to avoid timezone-related off-by-one-day errors.
    // caseBuilder stores dates as YYYY-MM-DD in UTC context.
    const d = new Date(dateStr + "T12:00:00Z");
    if (isNaN(d.getTime())) return dateStr;
    return d.toLocaleDateString("en-US", {
      year: "numeric",
      month: "long",
      day: "numeric",
      timeZone: "UTC",
    });
  } catch {
    return dateStr;
  }
}

function generateCaseRef(offender: OffenderProfile, generatedAt: Date): string {
  const datePart = generatedAt.toISOString().slice(0, 10).replace(/-/g, "");
  const phonePart = offender.normalizedNumber.slice(-4);
  // Add random suffix to prevent collisions from simultaneous requests
  const rand = crypto.randomBytes(3).toString("hex");
  return `SS-${datePart}-${phonePart}-${rand}`;
}

/**
 * Generate exhibit labels: A, B, ... Z, AA, AB, ... AZ, BA, ... ZZ, AAA, ...
 * Bijective base-26 (spreadsheet-column style). Handles any number of
 * exhibits without crashing — the earlier two-letter cap produced the
 * garbage label "[" (ASCII 91) at n=702.
 */
function createExhibitLabeler(): () => string {
  let index = 0;
  const issued = new Set<string>();
  const toLabel = (n: number): string => {
    let label = "";
    let x = n;
    while (true) {
      label = String.fromCharCode(65 + (x % 26)) + label;
      x = Math.floor(x / 26) - 1;
      if (x < 0) break;
    }
    return label;
  };
  return () => {
    const label = toLabel(index);
    // F6 (AUDIT_ROUND_16): defense-in-depth. The bijective base-26
    // algorithm is mathematically collision-free, but this generator
    // is consumed across four documents (petition, exhibit list, cert
    // of service, filing guide) and a future refactor that accidentally
    // resets `index` mid-generation would re-issue "A" to a second
    // exhibit — destroying evidence identification in court. A runtime
    // assertion makes that regression impossible to ship quietly.
    if (issued.has(label)) {
      throw new Error(
        `Exhibit labeler regression: label "${label}" issued twice ` +
        `(index=${index}). Two exhibits with the same letter would be ` +
        `un-provable at trial; refusing to continue.`
      );
    }
    issued.add(label);
    index++;
    return label;
  };
}

/**
 * Sanitize transcript text to redact PII before including in court filings.
 * Removes SSNs, credit card numbers, and other sensitive patterns.
 *
 * NOTE: The account-number regex deliberately carves out anything that
 * looks like a phone number — US (10/11-digit with optional +1) AND
 * international E.164 (+ followed by 8-15 digits). Earlier revisions
 * redacted international phone numbers as account numbers, which
 * corrupted the transcript evidence for calls from overseas call centers.
 */
function sanitizeTranscript(text: string): string {
  let sanitized = text;

  // Step 1: Redact SSN with dashes first (narrower, more specific).
  sanitized = sanitized.replace(/\b\d{3}-\d{2}-\d{4}\b/g, "[SSN REDACTED]");

  // Step 2: Redact 16-digit credit card patterns (with optional separators).
  sanitized = sanitized.replace(
    /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g,
    "[CC# REDACTED]"
  );

  // Step 3: Temporarily mask anything that LOOKS like a phone number so the
  // following account-number / SSN passes don't eat it. We put back the
  // original text verbatim at the end. The markers are deliberately
  // non-digit so subsequent regexes skip them.
  const phoneMarkers: string[] = [];
  const PHONE_MARK = "\x00PHONE_MARK_";
  // International E.164 (+[country][number], total 8-16 digits) OR
  // North American (optional +1/1, then 10 digits, with optional separators).
  const phonePattern =
    /(\+\d{1,3}[\s.-]?\(?\d{1,4}\)?[\s.-]?\d{1,4}[\s.-]?\d{1,9})|(\b(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b)/g;
  sanitized = sanitized.replace(phonePattern, (match) => {
    const idx = phoneMarkers.length;
    phoneMarkers.push(match);
    return `${PHONE_MARK}${idx}${PHONE_MARK}`;
  });

  // Step 4: Redact 9-digit standalone sequences as possible SSNs.
  sanitized = sanitized.replace(/\b\d{9}\b/g, "[POSSIBLE SSN REDACTED]");

  // Step 5: Redact long digit runs (bank accounts / routing numbers).
  sanitized = sanitized.replace(/\b\d{8,17}\b/g, "[ACCOUNT# REDACTED]");

  // Step 6: Restore the phone-number markers with the original text.
  sanitized = sanitized.replace(
    new RegExp(`${PHONE_MARK}(\\d+)${PHONE_MARK}`, "g"),
    (_m, idx) => phoneMarkers[parseInt(idx, 10)] ?? ""
  );

  return sanitized;
}

/**
 * Canonical defendant name used across ALL documents in the filing package.
 * This ensures the petition, exhibit list, certificate of service, and filing
 * guide all refer to the defendant identically — a mismatch would give the
 * defense an easy procedural challenge.
 *
 * Format:
 *   Known company   → "Acme Telemarketing LLC"
 *   Unknown company → "Unknown Entity (Phone: +15551234567)"
 */
function getDefendantName(offender: OffenderProfile): string {
  if (offender.companyName) return offender.companyName;
  return `Unknown Entity (Phone: ${offender.rawNumbers[0] ?? offender.normalizedNumber})`;
}

/**
 * Canonical "short" defendant name for filing guide prose where the full
 * "(Phone: ...)" suffix is awkward.
 */
function getDefendantShortName(offender: OffenderProfile): string {
  return offender.companyName ?? "the defendant";
}

/**
 * Parse the small claims limit from config and compute capped damages.
 * Centralized to prevent divergence across petition, exhibit list, and guide.
 */
function computeCappedDamages(
  totalDamages: number,
  smallClaimsLimit: string
): { cappedDamages: number; wasCapped: boolean; limitNum: number } {
  // Strip decimal portion first (e.g., "$10,000.00" → "$10,000"), THEN strip
  // non-digits. Without this, "$10,000.00" would become "1000000" (1 million)
  // instead of the intended 10000.
  const integerPart = smallClaimsLimit.replace(/\.\d+$/, "");
  const limitNum = parseInt(integerPart.replace(/[^0-9]/g, ""), 10) || 5000;
  const cappedDamages = Math.min(totalDamages, limitNum);
  return { cappedDamages, wasCapped: totalDamages > limitNum, limitNum };
}

/** Proper pluralization: "1 call" vs "2 calls" */
function pluralize(count: number, singular: string, plural?: string): string {
  return count === 1 ? `${count} ${singular}` : `${count} ${plural ?? singular + "s"}`;
}

/** Pluralization WITHOUT the count (for places where the count was already
 *  interpolated). "call" vs "calls". */
function pluralWord(count: number, singular: string, plural?: string): string {
  return count === 1 ? singular : plural ?? singular + "s";
}

/**
 * Map a USPS two-letter state code to the full state name.
 * AUDIT_ROUND_17 CRIT-5: sworn petition prose must read "Louisiana," not "LA."
 * A jurisdictional-facts paragraph that refers to the forum state by its
 * postal code is unpolished at best; the § 1746 verification clause
 * specifically invokes "the laws of the State of [X]" and needs the full
 * name. Address blocks continue to use the two-letter code.
 * Falls back to the input string (uppercased) for unrecognized codes, so
 * a typo or a non-US state never blocks filing.
 */
const US_STATE_NAMES: Record<string, string> = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas",
  CA: "California", CO: "Colorado", CT: "Connecticut", DE: "Delaware",
  FL: "Florida", GA: "Georgia", HI: "Hawaii", ID: "Idaho",
  IL: "Illinois", IN: "Indiana", IA: "Iowa", KS: "Kansas",
  KY: "Kentucky", LA: "Louisiana", ME: "Maine", MD: "Maryland",
  MA: "Massachusetts", MI: "Michigan", MN: "Minnesota", MS: "Mississippi",
  MO: "Missouri", MT: "Montana", NE: "Nebraska", NV: "Nevada",
  NH: "New Hampshire", NJ: "New Jersey", NM: "New Mexico", NY: "New York",
  NC: "North Carolina", ND: "North Dakota", OH: "Ohio", OK: "Oklahoma",
  OR: "Oregon", PA: "Pennsylvania", RI: "Rhode Island", SC: "South Carolina",
  SD: "South Dakota", TN: "Tennessee", TX: "Texas", UT: "Utah",
  VT: "Vermont", VA: "Virginia", WA: "Washington", WV: "West Virginia",
  WI: "Wisconsin", WY: "Wyoming", DC: "District of Columbia",
};

function stateNameLong(postal: string): string {
  const up = (postal ?? "").trim().toUpperCase();
  return US_STATE_NAMES[up] ?? postal;
}

/**
 * Strip any trailing parenthetical "(one-party consent)" from a recording-law
 * citation so we can render "La. R.S. 15:1303" cleanly in prose where we then
 * append our own descriptor. AUDIT_ROUND_17 CRIT-2: the Exhibit I declaration
 * appended "(one-party consent)" after the citation, but the config default
 * already includes the same parenthetical, producing "... (one-party consent)
 * (one-party consent)..." on the sworn authentication exhibit.
 */
function stripRecordingLawParen(citation: string): string {
  return citation.replace(/\s*\((?:one|two)-party consent\)\s*$/i, "").trim();
}

/**
 * M5 (AUDIT_ROUND_15): normalize the displayed small-claims cap so the same
 * underlying number always renders the same way, regardless of how the user
 * typed it in Settings ("$5000", "5,000", "$5,000.00", "5000.00" etc.).
 * This matters because the cap appears in multiple sworn paragraphs (prayer
 * for relief, DAMAGES section, exhibit) and inconsistent formatting looks
 * sloppy and invites a motion to clarify.
 */
function formatMoneyCap(s: string): string {
  const integerPart = s.replace(/\.\d+$/, "");
  const n = parseInt(integerPart.replace(/[^0-9]/g, ""), 10);
  if (isNaN(n) || n <= 0) return s; // fallback to user input if unparseable
  return `$${n.toLocaleString("en-US")}`;
}

/**
 * Authoritative damages calculation — the SINGLE source of truth used by
 * the validator, the petition's DAMAGES section, and the damages exhibit.
 *
 * Under 47 U.S.C. § 227(c)(5), trebled damages ($1,500) only apply to calls
 * that were themselves "willful or knowing" — i.e., calls placed after the
 * defendant had actual notice to stop. The clearest such notice is a formal
 * demand letter. Calls placed BEFORE the demand letter are ordinary $500
 * violations, even if the same defendant later becomes "willful."
 *
 * Applying $1,500 uniformly because one post-demand call exists is the kind
 * of over-claim that invites a defense motion to strike the entire willful
 * enhancement. This split calculation produces a defensible figure.
 */
const STANDARD_RATE = 500;
const WILLFUL_RATE = 1500;

export interface DamagesBreakdown {
  total: number;
  standardRate: number;   // $500
  willfulRate: number;    // $1,500
  standardCalls: number;  // calls at $500
  willfulCalls: number;   // calls at $1,500
  isSplit: boolean;       // true if some calls are willful and some aren't
}

function computeExpectedDamages(offender: OffenderProfile): DamagesBreakdown {
  if (!offender.willful || !offender.demandLetterSent || !offender.demandLetterDate) {
    return {
      total: offender.callCount * STANDARD_RATE,
      standardRate: STANDARD_RATE,
      willfulRate: WILLFUL_RATE,
      standardCalls: offender.callCount,
      willfulCalls: 0,
      isSplit: false,
    };
  }

  const demandDate = new Date(offender.demandLetterDate + "T00:00:00Z");
  if (isNaN(demandDate.getTime())) {
    return {
      total: offender.callCount * STANDARD_RATE,
      standardRate: STANDARD_RATE,
      willfulRate: WILLFUL_RATE,
      standardCalls: offender.callCount,
      willfulCalls: 0,
      isSplit: false,
    };
  }

  let pre = 0;
  let post = 0;
  for (const c of offender.calls) {
    const d = new Date(c.date + "T00:00:00Z");
    if (!isNaN(d.getTime()) && d > demandDate) post++;
    else pre++;
  }
  const total = pre * STANDARD_RATE + post * WILLFUL_RATE;
  return {
    total,
    standardRate: STANDARD_RATE,
    willfulRate: WILLFUL_RATE,
    standardCalls: pre,
    willfulCalls: post,
    isSplit: pre > 0 && post > 0,
  };
}

function buildCallLogTable(calls: CallEntry[]): string {
  let table = "  #   Date          Time    Call SID                            Recording   Transcript Excerpt\n";
  table +=    "  ──  ──────────    ─────   ─────────────────────────────────   ─────────   ─────────────────────\n";
  calls.forEach((c, i) => {
    const num = String(i + 1).padStart(2, " ");
    const rec = c.recordingUrl ? "Yes" : "No";
    const snippet = c.transcriptSnippet
      ? `"${sanitizeTranscript(c.transcriptSnippet.slice(0, 40))}${c.transcriptSnippet.length > 40 ? "..." : ""}"`
      : "(none)";
    table += `  ${num}   ${c.date}    ${c.time}   ${(c.callSid || "N/A").padEnd(34)}  ${rec.padEnd(10)}  ${snippet}\n`;
  });
  return table;
}

/**
 * Check statute of limitations. We use the most generous 4-year SOL, but note
 * that the TCPA SOL is actually UNSETTLED — some circuits borrow state SOL
 * (often 2-3 years). We check against 4 years but warn users to file ASAP.
 * Returns a warning string if any calls are approaching or past the deadline.
 */
function checkStatuteOfLimitations(offender: OffenderProfile): string | null {
  const SOL_YEARS = 4;
  const MINORITY_SOL_YEARS = 2; // conservative state-borrowing rule
  // Use UTC throughout — call dates are stored as YYYY-MM-DD in UTC context
  const now = new Date();

  const mkCutoff = (yearsBack: number) => {
    const d = new Date(Date.UTC(
      now.getUTCFullYear() - yearsBack,
      now.getUTCMonth(),
      now.getUTCDate()
    ));
    return d.toISOString().split("T")[0];
  };

  const cutoffStr = mkCutoff(SOL_YEARS);
  const minorityCutoffStr = mkCutoff(MINORITY_SOL_YEARS);

  // HARD BLOCK: if ALL calls are beyond even the generous 4-year cutoff, no
  // viable claim under any theory. Return a blocking warning.
  const validCalls4yr = offender.calls.filter((c) => c.date >= cutoffStr);
  if (validCalls4yr.length < 2) {
    return (
      `BLOCKING WARNING — STATUTE OF LIMITATIONS: After excluding calls ` +
      `older than ${SOL_YEARS} years (the most generous TCPA SOL under ` +
      `28 U.S.C. § 1658(a)), you have only ${validCalls4yr.length} ` +
      `timely call(s). The TCPA requires at least 2 calls within a ` +
      `12-month period, 47 U.S.C. § 227(c)(5). DO NOT FILE this case ` +
      `without consulting an attorney — a court is likely to dismiss it ` +
      `on SOL grounds. If you believe equitable tolling or a discovery ` +
      `rule applies, an attorney must make that argument for you.`
    );
  }

  // STRONG WARNING: if ALL calls are beyond the conservative 2-year
  // minority cutoff, the case is exposed to a motion-to-dismiss under any
  // jurisdiction that borrows state SOL. Warn but do not block (user may
  // have reason to proceed under the 4-year theory).
  const validCalls2yr = offender.calls.filter((c) => c.date >= minorityCutoffStr);
  if (validCalls2yr.length < 2) {
    return (
      `STRONG WARNING — STATUTE OF LIMITATIONS (2-YEAR RISK): All or ` +
      `nearly all of your ${offender.callCount} call(s) are older than ` +
      `${MINORITY_SOL_YEARS} years. You have ${validCalls2yr.length} ` +
      `call(s) within the conservative 2-year window. You are relying on ` +
      `the 4-year federal catch-all (28 U.S.C. § 1658(a)), which is the ` +
      `majority rule post-Mims (2012), but some courts still apply shorter ` +
      `state-borrowed SOLs as low as 1–2 years. Your case is viable under ` +
      `the 4-year rule but vulnerable to a motion to dismiss if the court ` +
      `borrows a shorter state SOL. Consider consulting an attorney before ` +
      `filing.`
    );
  }

  // Check if the FIRST call is older than 4 years (some barred, some OK)
  if (offender.firstCallDate < cutoffStr) {
    const barredCalls = offender.calls.filter((c) => c.date < cutoffStr);
    return (
      `NOTICE — STATUTE OF LIMITATIONS: ${barredCalls.length} of your ` +
      `${offender.callCount} call(s) occurred more than 4 years ago and may ` +
      `be time-barred under the TCPA's statute of limitations. The petition ` +
      `includes all calls for context but you should be aware the court may ` +
      `exclude damages for calls before ${formatDate(cutoffStr)}. You still ` +
      `have ${validCalls4yr.length} valid call(s) within the limitations period.`
    );
  }

  // Warn if approaching SOL (within 6 months)
  // Use setUTCMonth for safe arithmetic — Date.UTC handles month overflow
  // implicitly, but setUTCMonth is more explicit and readable
  const warningCutoff = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate()
  ));
  warningCutoff.setUTCFullYear(warningCutoff.getUTCFullYear() - SOL_YEARS);
  warningCutoff.setUTCMonth(warningCutoff.getUTCMonth() + 6);
  const warningStr = warningCutoff.toISOString().split("T")[0];

  if (offender.firstCallDate < warningStr) {
    return (
      `NOTICE — FILE SOON: Your earliest recorded call (${formatDate(offender.firstCallDate)}) ` +
      `is approaching the 4-year statute of limitations deadline. File this ` +
      `case as soon as possible to preserve your claims.`
    );
  }

  return null;
}

/**
 * Validate that an offender profile has the minimum data needed for a
 * legally sound filing. Prevents generating garbage petitions.
 */
function validateOffenderForFiling(offender: OffenderProfile): void {
  if (!offender.actionable) {
    throw new Error(`Case is not actionable (need 2+ calls in 12 months)`);
  }
  if (!Array.isArray(offender.calls) || offender.calls.length === 0) {
    throw new Error(`Offender has no call records — cannot generate filing`);
  }
  if (offender.callCount !== offender.calls.length) {
    throw new Error(
      `Data integrity error: callCount (${offender.callCount}) does not match ` +
      `calls array length (${offender.calls.length})`
    );
  }
  if (offender.callCount < 2) {
    throw new Error(
      `Only ${offender.callCount} call(s) recorded — TCPA requires 2+ calls ` +
      `in 12 months for a private right of action`
    );
  }
  if (!offender.normalizedNumber) {
    throw new Error(`Missing offender phone number`);
  }
  if (!offender.rawNumbers || offender.rawNumbers.length === 0) {
    throw new Error(`Missing rawNumbers array — cannot identify caller number`);
  }

  // Validate company name is not empty string (falsy but not nullish)
  if (offender.companyName !== null && offender.companyName !== undefined
      && offender.companyName.trim() === "") {
    throw new Error(
      `Data integrity error: companyName is an empty string. Set to null if ` +
      `unknown, or provide the actual company name.`
    );
  }

  // Validate demand letter consistency
  if (offender.demandLetterSent && !offender.demandLetterDate) {
    throw new Error(
      `Data integrity error: demandLetterSent is true but demandLetterDate is missing`
    );
  }
  if (offender.demandLetterDate && !/^\d{4}-\d{2}-\d{2}$/.test(offender.demandLetterDate)) {
    throw new Error(
      `Invalid demandLetterDate format: "${offender.demandLetterDate}" (expected YYYY-MM-DD)`
    );
  }
  if (offender.willful && !offender.demandLetterSent) {
    throw new Error(
      `Data integrity error: willful is true but no demand letter was sent`
    );
  }

  // Validate individual call records — use UTC to match date storage format
  const nowUtc = new Date();
  const todayStr = `${nowUtc.getUTCFullYear()}-${String(nowUtc.getUTCMonth() + 1).padStart(2, "0")}-${String(nowUtc.getUTCDate()).padStart(2, "0")}`;
  const seenCallSids = new Set<string>();

  offender.calls.forEach((call, idx) => {
    if (!call.date) {
      throw new Error(`Call ${idx + 1}: missing date`);
    }
    if (!call.callSid) {
      throw new Error(`Call ${idx + 1}: missing call SID`);
    }
    if (!call.time) {
      throw new Error(`Call ${idx + 1}: missing time`);
    }
    // Reject future-dated calls — would produce nonsensical petition
    if (call.date > todayStr) {
      throw new Error(
        `Call ${idx + 1}: date ${call.date} is in the future. Cannot include ` +
        `future-dated calls in a court filing.`
      );
    }
    // Reject duplicate callSids — would inflate damages count
    if (seenCallSids.has(call.callSid)) {
      throw new Error(
        `Duplicate call SID detected: ${call.callSid}. Each call must have a ` +
        `unique SID. Duplicate entries would inflate the damages count and ` +
        `destroy credibility in court.`
      );
    }
    seenCallSids.add(call.callSid);
  });

  // Ensure calls are in chronological order — auto-sort instead of throwing,
  // because caseBuilder may append calls out of order from async Twilio events
  offender.calls.sort((a, b) => {
    if (a.date !== b.date) return a.date.localeCompare(b.date);
    return a.time.localeCompare(b.time);
  });

  // ── 12-month sliding window validation ──────────────────────────────────
  // TCPA § 227(c)(5) requires "more than one telephone call within any
  // 12-month period." The caseBuilder `actionable` flag only checks
  // first/last dates, which can be wrong if calls span >12 months with
  // gaps. We verify here with a proper sliding window: for each call,
  // check if any OTHER call falls within the 12 months after it.
  let foundValidWindow = false;
  for (let i = 0; i < offender.calls.length && !foundValidWindow; i++) {
    const windowStart = new Date(offender.calls[i].date + "T00:00:00Z");
    const windowEnd = new Date(windowStart);
    windowEnd.setUTCMonth(windowEnd.getUTCMonth() + 12);
    const windowEndStr = windowEnd.toISOString().split("T")[0];

    // Count calls within [windowStart, windowEnd] — inclusive on both ends
    // TCPA says "within any 12-month period" — same-day anniversary counts
    let countInWindow = 0;
    for (const call of offender.calls) {
      if (call.date >= offender.calls[i].date && call.date <= windowEndStr) {
        countInWindow++;
      }
    }
    if (countInWindow >= 2) {
      foundValidWindow = true;
    }
  }
  if (!foundValidWindow) {
    throw new Error(
      `12-month window requirement NOT met: although there are ${offender.callCount} ` +
      `total calls, no two calls fall within the same 12-month period. The TCPA ` +
      `requires "more than one telephone call within any 12-month period" for a ` +
      `private right of action under § 227(c)(5). This case is not actionable.`
    );
  }

  // ── Sanitize offender text fields ────────────────────────────────────────
  // These fields are user/caller-provided and could contain control chars,
  // newlines, template injection attempts, Unicode bidi overrides, or
  // zero-width/format characters that would silently corrupt sworn text.
  //
  // PT1 (AUDIT_ROUND_16): a defendant that includes U+202E (RLO) in its
  // ANI-transmitted company name can make "ScamCo" render on the court
  // printout as "oCmacS" — literally mis-identifying the defendant in a
  // filing the plaintiff just swore to under penalty of perjury. The fix
  // strips the entire Unicode bidi/format block: U+200B-U+200F (zero-width
  // + directional marks), U+202A-U+202E (embedding + override), and
  // U+2066-U+2069 (isolates). Decomposed into two replace calls to avoid
  // accidentally nuking legitimate BMP characters.
  //
  // PT4 (AUDIT_ROUND_16): a defendant that transmits a 10-kilobyte
  // companyName destroyed the petition's formatting when printed — the
  // company name consumed entire pages of the filing. Cap to 200 chars
  // with a literal ellipsis marker so the truncation is obvious to the
  // reader (and to the clerk, if they ever diff the raw call log).
  const MAX_FIELD_CHARS = 200;
  const stripHostile = (s: string): string =>
    s
      .replace(/[\r\n]+/g, " ")
      .replace(/[\x00-\x1f]/g, "")
      .replace(/[\u200B-\u200F\u202A-\u202E\u2066-\u2069]/g, "")
      .trim();
  const capField = (s: string, max: number = MAX_FIELD_CHARS): string =>
    s.length <= max ? s : s.slice(0, max - 1) + "…";

  if (offender.purpose) {
    offender.purpose = capField(stripHostile(offender.purpose));
  }
  if (offender.companyName) {
    offender.companyName = capField(stripHostile(offender.companyName));
  }
  offender.callerNames = offender.callerNames.map((n: string) =>
    capField(stripHostile(n))
  );
  offender.calls.forEach((call) => {
    if (call.transcriptSnippet) {
      // Transcripts get a larger cap (1000 chars) since they're quoted
      // evidence, but still bounded so a pathological transcript can't
      // balloon a filing past a filer's printer budget.
      call.transcriptSnippet = capField(stripHostile(call.transcriptSnippet), 1000);
    }
  });

  // Validate damages estimate matches the authoritative calculation.
  // We use computeExpectedDamages() so the split-rate logic (pre/post
  // demand letter) is the single source of truth for the validator and
  // every downstream document.
  const expected = computeExpectedDamages(offender);
  if (offender.damagesEstimate !== expected.total) {
    throw new Error(
      `Damages mismatch: damagesEstimate is $${offender.damagesEstimate} but ` +
      `expected $${expected.total} (` +
      (expected.isSplit
        ? `${expected.standardCalls} pre-demand × $${expected.standardRate} + ` +
          `${expected.willfulCalls} post-demand × $${expected.willfulRate}`
        : `${offender.callCount} calls × $${
            expected.willfulCalls > 0 ? expected.willfulRate : expected.standardRate
          }`) +
      `). This inconsistency would be caught by opposing counsel.`
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  1. SMALL CLAIMS PETITION
//
//  Legal coverage:
//  - Count I:  47 U.S.C. § 227(c)(5) — DNC Registry violations
//  - Count II: 47 U.S.C. § 227(b)(1)(B) — Robocall/ATDS (if applicable)
//  - Count III: State DNC statute (La. R.S. 45:844.14)
//  - Preemptive defenses: safe harbor, EBR, prior consent
//  - Willfulness: strengthened language per court standards
// ─────────────────────────────────────────────────────────────────────────────

function generatePetition(
  offender: OffenderProfile,
  config: FilingConfig,
  caseRef: string,
  generatedAt: Date
): string {
  const company = getDefendantName(offender);
  const todayStr = generatedAt.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });
  const violationCount = offender.callCount;
  const damages = computeExpectedDamages(offender);
  // For documents that still need a single "per violation" number (e.g.,
  // the demand letter summary), use the willful rate when any post-demand
  // call is in play, otherwise the standard rate. Prefer the damages-
  // breakdown prose below for the petition.
  const damagesPerCall =
    damages.willfulCalls > 0 ? damages.willfulRate : damages.standardRate;
  const totalDamages = offender.damagesEstimate;

  // Human-readable calculation sentence for the petition and exhibit.
  // AUDIT_ROUND_17 CRIT-4: use toLocaleString() on EVERY money figure so
  // "$1,500" and "$500" render consistently with the "$5,000" total. The
  // prior template printed "$1500" because raw integers were interpolated
  // with a bare "$" prefix.
  const damagesCalcSentence = damages.isSplit
    ? `${damages.standardCalls} pre-demand-letter ` +
      `${damages.standardCalls === 1 ? "call" : "calls"} × ` +
      `$${damages.standardRate.toLocaleString()}/violation + ` +
      `${damages.willfulCalls} post-demand willful ` +
      `${damages.willfulCalls === 1 ? "call" : "calls"} × ` +
      `$${damages.willfulRate.toLocaleString()}/violation = ` +
      `$${damages.total.toLocaleString()}`
    : `${violationCount} ${violationCount === 1 ? "call" : "calls"} × ` +
      `$${damagesPerCall.toLocaleString()}/violation = $${totalDamages.toLocaleString()}`;

  // If damages exceed small claims limit, cap them
  const { cappedDamages, wasCapped } = computeCappedDamages(totalDamages, config.smallClaimsLimit);

  // Determine if any calls were robocalls/automated (for § 227(b) count)
  // B2 (AUDIT_ROUND_15): the prior comment had it exactly backwards.
  //   § 227(b)(1)(A)(iii) = calls to CELLULAR/paging/specified services
  //       using ATDS or artificial/prerecorded voice.
  //   § 227(b)(1)(B)     = calls to a RESIDENTIAL line using an artificial
  //       or prerecorded voice (ATDS alone is NOT enough under (B)).
  // Since SpamSlayer's theory of the case is that the DNC-registered line
  // is a residential line (see primary-use paragraph), the correct § 227(b)
  // hook for a prerecorded-voice call is (B). An (A)(iii) claim also exists
  // in the alternative if the line is shown to be a cellular number. Count
  // II below pleads both in the alternative.
  const hasRobocalls = offender.calls.some(
    (c) => c.callType === "robocall" || c.callType === "telemarketing"
  );

  // Check for exempt call types that would undermine the petition
  const hasDebtCalls = offender.calls.some(
    (c) => c.callType === "debt_collection"
  );
  const hasPoliticalCalls = offender.calls.some(
    (c) => c.callType === "political"
  );
  const hasSurveyCalls = offender.calls.some(
    (c) => c.callType === "survey"
  );

  // Cap call list at 15 entries in the petition body to avoid overwhelming
  // the judge. Full list is always in the Exhibit List (call log table).
  const MAX_PETITION_CALLS = 15;
  const callListEntries = offender.calls.slice(0, MAX_PETITION_CALLS)
    .map((c, i) =>
      `        ${i + 1}. On ${formatDate(c.date)} at approximately ${c.time}` +
      `${c.recordingUrl ? " (recorded)" : ""}` +
      `${c.callType && c.callType !== "unknown" ? ` [${c.callType}]` : ""}`
    );
  if (offender.calls.length > MAX_PETITION_CALLS) {
    callListEntries.push(
      `        ... and ${offender.calls.length - MAX_PETITION_CALLS} additional ` +
      `call(s). See Exhibit B (Complete Call Log) for the full list.`
    );
  }
  const callListForPetition = callListEntries.join("\n");

  // Track paragraph numbering
  let para = 1;
  const p = () => para++;

  return `═══════════════════════════════════════════════════════════════════════
                         ${config.courtName.toUpperCase()}
                    ${config.parishOrCounty.toUpperCase()}, ${config.courtState}
═══════════════════════════════════════════════════════════════════════

Court File No: ________________  (Assigned by Clerk)

${config.userName},                                    )
     Plaintiff,                                        )
                                                       )     SMALL CLAIMS
vs.                                                    )     PETITION
                                                       )
${company},                                            )     Internal Ref: ${caseRef}
     Defendant.                                        )
                                                       )

═══════════════════════════════════════════════════════════════════════

PETITION FOR DAMAGES UNDER THE TELEPHONE CONSUMER PROTECTION ACT

Comes now Plaintiff, ${config.userName}, in proper person, who
respectfully represents to this Honorable Court as follows:

                              I. PARTIES

${p()}.  Plaintiff, ${config.userName}, is a natural person residing at
    ${config.userAddress}, ${config.userCity}, ${config.courtState}
    ${config.userZip}, and is the residential telephone subscriber of
    telephone number ${config.userPhone}. Plaintiff had the right to
    expect no unsolicited calls in violation of the TCPA.

${p()}.  Defendant is ${company}, an entity that placed or caused to be
    placed unsolicited telephone calls to Plaintiff's telephone number.
    Defendant's physical address for service of process is:
    ___________________________________________________________
    (Plaintiff to insert address per "Before You File" instructions;
    for a corporation or LLC, the petition must be served on Defendant's
    registered agent — see the Filing Guide and Certificate of Service
    for lookup steps, La. R.S. 12:308 and Secretary of State registry).
    The originating telephone number used to place calls at issue was
    ${offender.rawNumbers[0] ?? offender.normalizedNumber}.
${offender.callerNames.filter((n: string) => n.trim()).length > 0
  ? `    Names used by callers during the calls (true identity not
    verified and subject to discovery): ${offender.callerNames.filter((n: string) => n.trim()).join(", ")}.`
  : ""}

${p()}.  All calls at issue originated from or were made on behalf of
    Defendant, a single entity. Defendant placed
    ${pluralize(violationCount, "call")} to Plaintiff's number${
      offender.firstCallDate === offender.lastCallDate
        ? ` on ${formatDate(offender.firstCallDate)}`
        : ` between ${formatDate(offender.firstCallDate)} and ${formatDate(offender.lastCallDate)}`
    }, with two or more calls
    occurring within a single 12-month period as required by
    47 U.S.C. § 227(c)(5).

                          II. JURISDICTION

${p()}.  This Court has subject matter jurisdiction over this action.
    The amount in controversy does not exceed ${formatMoneyCap(config.smallClaimsLimit)},
    within this Court's jurisdictional limit under ${config.smallClaimsStatute.replace(/\.\s*$/, "")}.
    State courts of general jurisdiction have concurrent jurisdiction
    over private TCPA claims. See Mims v. Arrow Financial Services,
    LLC, 565 U.S. 368 (2012) (holding that federal and state courts
    have concurrent jurisdiction over private actions under the TCPA).
    The TCPA expressly authorizes suit "in an appropriate court of
    [the] State," 47 U.S.C. § 227(c)(5), which includes this Court
    as a court of competent jurisdiction for civil claims within its
    monetary limit.

${p()}.  This Court has personal jurisdiction over Defendant. Defendant
    purposefully directed telemarketing calls into the State of
    ${stateNameLong(config.courtState)} by placing ${pluralize(violationCount, "telephone call")} to
    Plaintiff's ${stateNameLong(config.courtState)} telephone number. By initiating
    commercial solicitations to a ${stateNameLong(config.courtState)} area code,
    Defendant transacted business in ${stateNameLong(config.courtState)} within the
    meaning of La. R.S. 13:3201(a) (Louisiana long-arm statute).
    Plaintiff's cause of action arises directly from Defendant's
    contacts with ${stateNameLong(config.courtState)} — the calls themselves. This
    satisfies the specific personal jurisdiction requirements of due
    process: purposeful availment (Defendant deliberately called a
    ${stateNameLong(config.courtState)} number), relatedness (the claim arises from
    those calls), and reasonableness (Defendant bears the burden of
    showing jurisdiction is unreasonable, and a telemarketer who
    calls into a state cannot fairly claim surprise at being sued
    there). See La. R.S. 13:3201(a); Burger King Corp. v. Rudzewicz,
    471 U.S. 462 (1985).

                         III. FACTS

${p()}.  Plaintiff's telephone number, ${config.userPhone}, has been
    registered on the National Do Not Call Registry maintained by the
    Federal Trade Commission since ${config.dncRegistrationDate}, which
    predates all calls at issue in this action. Exhibit A, the DNC
    Registry verification printout, confirms the registration date.
    All of Defendant's calls occurred after Plaintiff's registration,
    and Defendant was required to honor Plaintiff's DNC registration
    within 31 days of its effective date. See 47 C.F.R. § 64.1200(c)(2).

${p()}.  Despite this registration, Defendant placed ${violationCount}
    unsolicited telephone ${violationCount === 1 ? "call" : "calls"} to Plaintiff's number between
    ${formatDate(offender.firstCallDate)} and ${formatDate(offender.lastCallDate)}.
    Each call constitutes a separate violation:

${callListForPetition}

${p()}.  Plaintiff utilizes an automated telephone compliance system
    ("SpamSlayer") to answer and document unsolicited calls on
    Plaintiff's behalf. This system operates as Plaintiff's authorized
    agent for the limited purpose of answering incoming calls,
    recording the interaction, and collecting identifying information
    about the caller — functionally identical to an answering machine,
    voicemail system, or human secretary. Plaintiff is and remains the
    residential telephone subscriber and the real party in interest
    with standing to bring this action. The TCPA protects Plaintiff's
    right as a subscriber to be free from unsolicited calls to a
    DNC-registered number — not merely the right to personally answer
    each call. See 47 U.S.C. § 227(c)(5) (protecting "a person who
    has received more than one telephone call"); the calls were
    "received" at Plaintiff's number regardless of the answering
    mechanism. Plaintiff's subscriber status is independently
    verifiable through carrier records and billing statements.

${(() => {
  // H4 (AUDIT_ROUND_15): do NOT swear to residential primary use unless the
  // user has affirmatively confirmed the line type. Absent confirmation,
  // plead standing in jurisdictionally neutral terms and let the user edit
  // the draft to match their actual situation before filing.
  switch (config.lineType) {
    case "residential":
      return `${p()}.  Plaintiff's telephone number is used primarily for
    residential and personal purposes, qualifying Plaintiff as a
    "residential telephone subscriber" under the TCPA and its
    implementing regulations. The FCC has recognized that a line
    used for primarily personal or residential purposes remains
    entitled to DNC protection even where the subscriber also
    makes or receives incidental business-related calls from the
    same number. See In re Rules and Regulations Implementing the
    Telephone Consumer Protection Act of 1991, 68 Fed. Reg. 44144,
    44177 (July 25, 2003) (adopting a "totality of the
    circumstances" / primary-use test for residential status
    of mixed-use lines).`;
    case "mixed":
      return `${p()}.  Plaintiff's telephone number is used primarily for
    residential and personal purposes, although Plaintiff also
    makes or receives incidental business-related calls from the
    same number. Under the FCC's totality-of-the-circumstances /
    primary-use test, a line used primarily for personal or
    residential purposes remains entitled to DNC protection even
    where the subscriber also makes or receives incidental
    business calls. See In re Rules and Regulations Implementing
    the Telephone Consumer Protection Act of 1991, 68 Fed. Reg.
    44144, 44177 (July 25, 2003). To the extent Defendant
    attempts to reclassify Plaintiff's line as a "business" line
    based on incidental business use, that defense fails under
    the primary-use test and the burden rests with Defendant.`;
    case "cellular":
      return `${p()}.  Plaintiff's telephone number is assigned to a
    cellular telephone service. Calls to cellular numbers using
    an artificial or prerecorded voice or an automatic telephone
    dialing system are independently prohibited by 47 U.S.C.
    § 227(b)(1)(A)(iii) absent prior express consent, and DNC
    registrations apply to cell numbers by FCC rule.`;
    case "unspecified":
    default:
      return `${p()}.  Plaintiff is a subscriber of the telephone line at
    issue and the real party in interest. The specific DNC
    classification of the line (residential, cellular, or mixed)
    will be confirmed at trial based on carrier records and
    Plaintiff's testimony. Registration on the National Do Not
    Call Registry is itself evidence that Plaintiff holds the
    line in a capacity protected by 47 U.S.C. § 227(c).`;
  }
})()}

${(() => {
  // B1 (AUDIT_ROUND_15): do NOT claim "all calls were recorded" unless that
  // is literally true. Perjury-under-penalty-of-law attaches to every
  // assertion in this petition; a single un-recorded call makes a blanket
  // "all calls were recorded" paragraph a false statement.
  const totalCalls = offender.calls.length;
  const recordedCalls = offender.calls.filter((c) => c.recordingUrl).length;
  const unrecordedCalls = totalCalls - recordedCalls;
  const allRecorded = recordedCalls === totalCalls && totalCalls > 0;
  const someRecorded = recordedCalls > 0 && recordedCalls < totalCalls;
  const noneRecorded = recordedCalls === 0;
  if (allRecorded) {
    return `${p()}.  Each of the ${totalCalls} call${totalCalls === 1 ? "" : "s"} at issue was
    recorded under ${stripRecordingLawParen(config.stateRecordingLaw)},
    a one-party consent jurisdiction, and 18 U.S.C. § 2511(2)(d),
    which permits recording by any party to a telephone conversation.
    Plaintiff, as the subscriber and a party to each call through
    Plaintiff's authorized agent, provided the requisite one-party
    consent under both state and federal law. Additionally,
    Plaintiff's compliance system verbally notified Defendant's
    caller during each call that the call was being recorded and
    that Plaintiff's number is on the Do Not Call Registry,
    providing Defendant with actual notice and an opportunity to
    disconnect. The recordings were made contemporaneously with
    each call and, to the best of Plaintiff's knowledge, have not
    been edited, spliced, or altered since capture. Full recordings,
    metadata, cryptographic integrity hashes (SHA-256), and
    transcripts are preserved and attached as exhibits.`;
  }
  if (someRecorded) {
    return `${p()}.  Of the ${totalCalls} calls at issue, ${recordedCalls} ${recordedCalls === 1 ? "was" : "were"}
    captured as a full audio recording under ${stripRecordingLawParen(config.stateRecordingLaw)},
    a one-party consent jurisdiction, and 18 U.S.C. § 2511(2)(d).
    Plaintiff, as the subscriber and a party to each recorded call
    through Plaintiff's authorized agent, provided the requisite
    one-party consent under both state and federal law. The remaining
    ${unrecordedCalls} call${unrecordedCalls === 1 ? "" : "s"} ${unrecordedCalls === 1 ? "is" : "are"} documented by call-detail records
    only (date, time, originating number, and duration), captured
    contemporaneously by Plaintiff's compliance system and
    independently corroborated by Plaintiff's carrier Call Detail
    Records. During each call (recorded or not), Plaintiff's
    compliance system verbally notified Defendant's caller that
    Plaintiff's number is on the Do Not Call Registry, providing
    Defendant with actual notice and an opportunity to disconnect.
    To the best of Plaintiff's knowledge the audio recordings have
    not been edited, spliced, or altered since capture; full
    recordings, metadata, cryptographic integrity hashes (SHA-256),
    and transcripts for the recorded calls are preserved and
    attached as exhibits, and call-detail records for the remaining
    calls are likewise attached.`;
  }
  // noneRecorded — no audio exhibits; rely on CDRs only.
  void noneRecorded;
  return `${p()}.  Plaintiff's compliance system answered each call and
    verbally notified Defendant's caller that Plaintiff's number is
    on the Do Not Call Registry, providing Defendant with actual
    notice and an opportunity to disconnect. Call metadata (date,
    time, originating number, duration) was captured and preserved
    by both the SpamSlayer compliance system and the Twilio
    telecommunications platform. Plaintiff's carrier Call Detail
    Records independently corroborate each call. Plaintiff does not
    offer an audio recording for any of the ${totalCalls} call${totalCalls === 1 ? "" : "s"} at issue;
    the call-detail records alone are offered as proof of the fact,
    time, and originating number of each call.`;
})()}

${p()}.  The use of an automated compliance system does not diminish
    Plaintiff's claims. Plaintiff, as a residential telephone
    subscriber, suffered the following concrete and particularized
    injuries from each of Defendant's unlawful calls:
        (a) Invasion of Plaintiff's legally protected privacy interest
            in being free from unwanted commercial solicitations to a
            DNC-registered residential telephone number — each call
            intruded upon Plaintiff's private residential space and
            peace, regardless of the answering mechanism, just as a
            trespass harms the landowner whether or not the landowner
            is physically present when the trespasser enters;
        (b) Occupation and consumption of Plaintiff's telephone line
            and telecommunications infrastructure during each call,
            rendering the line unavailable for legitimate personal
            calls during the violation;
        (c) Consumption of Plaintiff's telecommunications resources
            each time Defendant's call rang through, including the
            depletion of Plaintiff's finite monthly minutes, battery
            and device wear, and the diversion of Plaintiff's
            attention from legitimate use of the line; Plaintiff also
            incurs additional documented third-party telecommunications
            costs (platform, storage, and bandwidth charges) to
            preserve the evidentiary record of each unlawful call;
        (d) Violation of Plaintiff's statutory right under 47 U.S.C.
            § 227(c) to be free from calls in violation of DNC
            regulations — a right Congress specifically created to
            protect residential subscribers like Plaintiff, exercised
            when Plaintiff affirmatively registered on the DNC list.
    These injuries bear a close relationship to the harms
    traditionally recognized as providing a basis for a lawsuit in
    American courts. Specifically: (a) maps to intrusion upon
    seclusion (Restatement (Second) of Torts § 652B); (b) maps to
    trespass to chattels — Defendant's call commandeered Plaintiff's
    telecommunications infrastructure without authorization, just
    as unauthorized use of a computer network constitutes trespass
    to chattels (see CompuServe Inc. v. Cyber Promotions, Inc.,
    962 F. Supp. 1015 (S.D. Ohio 1997)); (c) constitutes actual
    out-of-pocket economic harm; and (d) is the precise harm
    Congress identified and created § 227(c) to prevent.
    See Spokeo, Inc. v. Robins, 578 U.S. 330 (2016) (a plaintiff
    must show "concrete" injury, but intangible injuries including
    statutory violations can qualify); TransUnion LLC v. Ramirez,
    594 U.S. 413 (2021) (plaintiffs must demonstrate concrete harm
    with a close relationship to a traditionally recognized harm).
    Plaintiff's injuries satisfy both the Spokeo concreteness test
    and the TransUnion "close relationship" test through multiple
    independent channels: physical infrastructure harm (line
    occupation, system costs), privacy invasion (intrusion upon
    seclusion of a DNC-registered subscriber), and violation of a
    congressionally created right that Plaintiff affirmatively
    exercised by registering on the DNC list. The harm accrues to
    Plaintiff as the subscriber and owner of the telephone line,
    not to whichever device or agent happens to answer — just as
    a trespass harms the property owner regardless of whether the
    owner is physically present when the trespasser enters, and
    unauthorized network access harms the network owner regardless
    of whether automated security systems detected the intrusion.

${p()}.  Plaintiff's use of a compliance system to document violations
    does not constitute litigation manufacturing — it is the
    prudent preservation of evidence of violations that Defendant
    chose to commit. The violation occurred when Defendant dialed
    Plaintiff's DNC-registered number, not when the call was
    answered or recorded. Plaintiff registered on the National Do
    Not Call Registry for its protective purpose, to stop unwanted
    calls; the evidentiary record of Defendant's calls was created
    only because Defendant persisted in making calls that Plaintiff
    had affirmatively refused.

${p()}.  The out-of-court statements of the caller(s) captured in the
    recordings and transcripts attached hereto are offered against
    Defendant and are therefore NOT HEARSAY under Fed. R. Evid.
    801(d)(2)(D) and La. Code of Evidence Art. 801(D)(3)(b) as
    statements by a person authorized by Defendant to make a
    statement concerning the subject, or by Defendant's agent or
    employee acting within the scope of that relationship. In the
    alternative, the statements are admissible as party-opponent
    admissions under Fed. R. Evid. 801(d)(2)(A)/(B)/(C) and
    La. C.E. Art. 801(D)(3)(a) as Defendant's own statement (in a
    representative capacity) to the extent the caller spoke on
    Defendant's behalf, or as statements Defendant adopted by
    conducting the solicitations described. The recordings themselves
    are further admissible as business records kept in the regular
    course of the Twilio telecommunications platform's activities
    under Fed. R. Evid. 803(6) and La. Code of Evidence Art. 803(6),
    and are self-authenticating as to machine-generated data and
    digital hashes under Fed. R. Evid. 902(13)–(14). To the extent any
    statement in the recordings is offered for a non-truth purpose —
    to prove that the call occurred, that a pitch was delivered, or
    that a solicitation was made — it is by definition not hearsay
    under Fed. R. Evid. 801(c).

${p()}.  ${offender.purpose
      ? `Defendant's calls were for the purpose of: ${offender.purpose}.`
      : "Defendant's calls were unsolicited commercial solicitations."}
    As evidenced by the recordings and transcripts attached hereto,
    these calls constitute "telephone solicitations" as defined in
    47 C.F.R. § 64.1200(f)(12), falling squarely within the DNC
    Registry protections of 47 U.S.C. § 227(c). The calls were not
    made for emergency purposes, charitable solicitation, or any
    other exempt purpose under 47 C.F.R. § 64.1200(c)(2).

${p()}. Plaintiff has no knowledge or record of ever providing prior
    express written consent to receive telephone calls from Defendant.
    To the best of Plaintiff's knowledge, after reasonable inquiry
    into Plaintiff's records, Plaintiff has not: (a) completed any
    form, application, or agreement with Defendant; (b) inquired
    about Defendant's products or services; (c) provided Plaintiff's
    telephone number to Defendant or knowingly authorized any third
    party to share it with Defendant; or (d) taken any action that
    could reasonably be construed as inviting contact from Defendant.
    Plaintiff is not aware of any transaction, lead form, or
    relationship with Defendant that would have supplied the
    required prior express consent. The burden of proving prior
    express consent rests with Defendant, and to the extent Defendant
    alleges consent, Plaintiff will challenge its validity and
    specificity. See 47 C.F.R. § 64.1200(c).

${p()}. The fact that Plaintiff's compliance system engaged in
    conversation with Defendant's caller does not constitute express
    or implied consent to receive future calls. Consent under the
    TCPA requires affirmative prior authorization, not mere
    participation in an unsolicited call that Defendant initiated
    without permission. The automated system's interaction with the
    caller was for the sole purpose of documenting a violation
    already in progress — it did not and could not retroactively
    authorize the call or any subsequent calls.

${p()}. Plaintiff has no knowledge or record of any established business
    relationship ("EBR") with Defendant at any time relevant to this
    action. After reasonable inquiry into Plaintiff's own records,
    Plaintiff has not, within 18 months prior to the calls at issue,
    made any purchase, entered into any transaction, or made any
    inquiry with Defendant, nor made any inquiry within 3 months
    prior to the calls. On the facts known to Plaintiff, the EBR
    exception under 47 C.F.R. § 64.1200(f)(5) does not apply; the
    burden of establishing an EBR rests with Defendant.
    To the extent Plaintiff's compliance system asked questions during
    the call (such as "What company are you with?" or "What are you
    calling about?"), these were documentary identification questions
    to preserve evidence — not expressions of interest in Defendant's
    products or services. An "inquiry" under 47 C.F.R.
    § 64.1200(f)(5)(iii)(B) requires affirmative expression of
    interest in purchasing goods or services. Documenting an
    unsolicited violation is not a commercial inquiry.

${p()}. Plaintiff's use of a compliance system to answer and record
    calls does not constitute entrapment, unclean hands, or any
    equitable bar to relief. Entrapment is a criminal defense
    available only against government agents and is inapplicable to
    civil TCPA claims between private parties. The doctrine of
    unclean hands requires misconduct by the plaintiff related to
    the subject matter of the litigation — Plaintiff engaged in no
    misconduct by answering and recording calls placed to Plaintiff's
    own telephone number in a one-party consent jurisdiction. Each
    violation was complete when Defendant dialed Plaintiff's
    DNC-registered number; the subsequent conversation and recording
    are evidence of the violation, not the cause of it.

${offender.demandLetterSent
  ? `${p()}. On ${formatDate(offender.demandLetterDate!)}, Plaintiff sent a written
    cease-and-desist demand to Defendant via certified mail, requesting
    that Defendant immediately cease all calls to Plaintiff's number
    and pay statutory damages. ${offender.willful
      ? `Defendant continued to place calls to Plaintiff's number after\n    said notice was sent, from which a willful and knowing violation\n    of the TCPA may be inferred within the meaning of 47 U.S.C.\n    § 227(c)(5)(B). See also ¶ 24 below.`
      : `Defendant failed to respond to said demand within 30 days.`}`
  : `${p()}. Plaintiff has documented all violations and preserved evidence
    for this proceeding.`}

                     IV. CAUSES OF ACTION

         COUNT I: VIOLATION OF 47 U.S.C. § 227(c)(5)
         (National Do Not Call Registry Violations)

${p()}. The regulations prescribed under 47 U.S.C. § 227(c) include the
    National Do Not Call Registry provisions at 47 C.F.R. § 64.1200(c),
    which prohibit telephone solicitations to residential telephone
    subscribers who have registered their numbers on the National
    Do Not Call Registry.

${p()}. Defendant violated these regulations by placing
    ${pluralize(violationCount, "call")} to Plaintiff's registered telephone number within a
    12-month period.

${p()}. Under 47 U.S.C. § 227(c)(5), a person who has received more than
    one telephone call within any 12-month period by or on behalf of
    the same entity in violation of the regulations prescribed under
    this subsection may bring a private right of action to recover
    the greater of actual monetary loss or up to $500 in damages for
    each such violation.

${p()}. Plaintiff elects to recover statutory damages of $500 per
    violation (or up to $1,500 per violation if willful) in lieu of
    actual monetary loss, as statutory damages are greater.

${offender.willful
  ? `${p()}. Defendant's violations were willful and knowing within the meaning
    of 47 U.S.C. § 227(c)(5)(B). Defendant knew or should have known
    that calling a telephone number registered on the National Do Not
    Call Registry violates 47 U.S.C. § 227(c) and its implementing
    regulations, particularly after receiving Plaintiff's written
    cease-and-desist demand on ${formatDate(offender.demandLetterDate!)}.
    Under § 227(c)(5)(B), the Court may treble damages up to $1,500
    per violation.`
  : `${p()}. Plaintiff reserves the right to demonstrate that Defendant's
    violations were willful or knowing, which would entitle Plaintiff
    to treble damages of up to $1,500 per violation under
    47 U.S.C. § 227(c)(5)(B).`}

${p()}. Defendant has not demonstrated compliance with the safe harbor
    provisions of 47 C.F.R. § 64.1200(c)(2). Defendant bears the
    burden of proving it maintained written Do Not Call policies,
    trained its personnel, and scrubbed its call lists against the
    National Do Not Call Registry within 31 days prior to the calls
    at issue. The fact that Defendant called Plaintiff's DNC-registered
    number ${pluralize(violationCount, "time")} is circumstantial evidence that
    Defendant failed to maintain adequate DNC compliance procedures.
${hasRobocalls ? `
         COUNT II: VIOLATION OF 47 U.S.C. § 227(b)
         (Artificial or Prerecorded Voice / Automated Dialing)

${p()}. One or more of Defendant's calls to Plaintiff's telephone number
    were placed using an artificial or prerecorded voice, as
    evidenced by (a) the absence of a live human voice at the
    beginning of the call (no natural pause, breathing, or human
    greeting delay); (b) the use of prerecorded or synthesized audio
    content; and/or (c) the pattern and timing of calls consistent
    with automated delivery rather than manual placement. These
    observable characteristics are documented in the attached call
    recordings, transcripts, and/or call-detail records. In the
    alternative, and to the extent discovery reveals Defendant used
    equipment meeting the definition of an automatic telephone
    dialing system ("ATDS") under Facebook, Inc. v. Duguid, 141 S.
    Ct. 1163 (2021), Plaintiff pleads § 227(b) liability on that
    alternative theory as well.

${p()}. Under 47 U.S.C. § 227(b)(1)(B), it is unlawful — absent an
    emergency purpose or prior express consent — to initiate any
    telephone call to a residential telephone line using an
    artificial or prerecorded voice to deliver a message without
    the prior express consent of the called party. ${
      config.lineType === "residential" || config.lineType === "mixed"
        ? `Plaintiff's line is a residential telephone line (see
    primary-use paragraph above) and Plaintiff is not aware of
    having given Defendant prior express consent to receive such
    calls.`
        : `To the extent Plaintiff's line qualifies as a residential
    telephone line under the FCC's primary-use test, § 227(b)(1)(B)
    applies; Plaintiff is not aware of having given Defendant prior
    express consent to receive such calls.`
    }${
  config.lineType === "cellular" || config.lineType === "mixed" || config.lineType === "unspecified"
    ? `\n\n${p()}. ${
        config.lineType === "cellular"
          ? "Plaintiff's number at issue is assigned to a cellular telephone service. Defendant's calls therefore"
          : config.lineType === "mixed"
            ? "To the extent any of Plaintiff's numbers at issue is assigned to a cellular telephone service, those calls"
            : "In the alternative, to the extent any of Plaintiff's numbers at issue is assigned to a cellular telephone service, those calls"
      }
    independently violate 47 U.S.C. § 227(b)(1)(A)(iii), which
    prohibits any call (other than a call made for emergency
    purposes or made with the prior express consent of the called
    party) made using any automatic telephone dialing system or an
    artificial or prerecorded voice to any telephone number assigned
    to a cellular telephone service.`
    : ""}

${p()}. Under Facebook, Inc. v. Duguid, 141 S. Ct. 1163 (2021), an
    ATDS must have the capacity to use a random or sequential number
    generator to either store or produce telephone numbers to be
    called. Duguid narrowed the ATDS definition but did not disturb
    § 227(b)(1)(B)'s separate prohibition on artificial or prerecorded
    voice messages to residential lines, which does not require proof
    of an ATDS. Based on the observable automated characteristics of
    Defendant's calls and the volume and pattern of calls placed,
    Plaintiff asserts upon information and belief that Defendant used
    an artificial or prerecorded voice and/or ATDS equipment meeting
    this definition. Even if Defendant's equipment does not qualify
    as an ATDS under Duguid, the use of an artificial or prerecorded
    voice to a residential line independently violates § 227(b)(1)(B).

${p()}. Under 47 U.S.C. § 227(b)(3), a person who has received a call
    in violation of § 227(b) or its implementing regulations may bring
    a private right of action to recover the greater of actual
    monetary loss or $500 for each such violation, and the Court may
    treble damages up to $1,500 per violation for willful or knowing
    violations.
` : ""}
${config.stateDncStatute !== "N/A"
  ? `         COUNT ${hasRobocalls ? "III" : "II"}: VIOLATION OF STATE DO-NOT-CALL LAW

${p()}. Defendant additionally violated ${config.stateDncStatute}, the
    state Do Not Call statute. To the extent this statute provides
    an independent private right of action, Plaintiff seeks
    supplemental statutory damages thereunder. In the alternative,
    this count is stated as derivative of Count I, as Defendant's
    violation of the federal DNC regulations constitutes concurrent
    violation of state law, and state courts may award remedies
    available under both federal and state authority.`
  : ""}

                        V. DAMAGES

${wasCapped
  ? `${p()}. Plaintiff is entitled to statutory damages calculated as:
    ${damagesCalcSentence}.${damages.isSplit
      ? `\n    Only post-demand calls are claimed at the willful rate of
    $${damages.willfulRate.toLocaleString()}/violation; pre-demand calls are claimed
    at the standard rate of $${damages.standardRate.toLocaleString()}/violation, as
    trebling under 47 U.S.C. § 227(c)(5) requires a willful or
    knowing violation.`
      : ""}
    Plaintiff voluntarily reduces the claim to ${formatMoneyCap(config.smallClaimsLimit)}
    to remain within this Court's jurisdictional limit and waives
    the excess. Plaintiff elects this forum for the efficiency and
    accessibility of small claims procedure.

${p()}. Plaintiff requests judgment in the amount of ${formatMoneyCap(config.smallClaimsLimit)}.`
  : `${p()}. Plaintiff is entitled to statutory damages calculated as:
    ${damagesCalcSentence}.${damages.isSplit
      ? `\n    Only post-demand calls are claimed at the willful rate of
    $${damages.willfulRate.toLocaleString()}/violation; pre-demand calls are claimed
    at the standard rate of $${damages.standardRate.toLocaleString()}/violation, as
    trebling under 47 U.S.C. § 227(c)(5) requires a willful or
    knowing violation.`
      : ""}

${p()}. Plaintiff requests judgment in the amount of $${totalDamages.toLocaleString()}.`}

${p()}. Plaintiff additionally requests reimbursement of court costs
    including filing fees and certified mail service charges.
    Plaintiff currently appears in proper person; Plaintiff reserves
    the right to retain counsel and to seek any reasonable attorney's
    fees, costs, and expenses that may be available by statute, rule,
    or equity at any stage of this proceeding.

                        VI. PRAYER

WHEREFORE, Plaintiff prays that this Honorable Court:

    a) Enter judgment in favor of Plaintiff and against Defendant;

    b) Award Plaintiff statutory damages of $${cappedDamages.toLocaleString()},
       or such lesser amount as the Court deems just, in any event
       within this Court's jurisdictional limit, with Plaintiff
       waiving any excess;

    c) Award Plaintiff court costs including filing fees and
       service of process fees;

    d) Award such other and further relief as the Court deems just
       and proper.

Respectfully submitted,

${todayStr}


____________________________________
${config.userName}, Plaintiff in Proper Person
${config.userAddress}
${config.userCity}, ${config.courtState} ${config.userZip}
${config.userPhone}
${config.userEmail}


VERIFICATION

I, ${config.userName}, declare under penalty of perjury under the
laws of the United States of America (28 U.S.C. § 1746) and under
the laws of the State of ${stateNameLong(config.courtState)} that the facts stated
in this petition are true and correct to the best of my knowledge,
information, and belief. This petition was prepared with the
assistance of SpamSlayer, a consumer telephone-compliance software
tool that I operate on my own telephone line; I have personally
reviewed each factual allegation in this petition, independently
of any generated draft text, and each allegation is based on my
own call records, observations, and personal knowledge.

I have personal knowledge of the following facts: I am the
subscriber of the telephone number at issue${
  config.lineType === "residential"
    ? " and use the number primarily for residential and personal purposes"
    : config.lineType === "mixed"
      ? " and use the number primarily for residential and personal purposes, with incidental business use"
      : config.lineType === "cellular"
        ? ", which is assigned to a cellular telephone service"
        : ""
}; I registered
my number on the National Do Not Call Registry on or about
${config.dncRegistrationDate}; each call at issue was placed
to my telephone line and was received at my number; to the best
of my knowledge, information, and belief, and after reasonable
review of my own records, I have no prior business relationship
with Defendant and I did not provide prior express written or
oral consent for Defendant to call me.

I installed and configured a telephone compliance system
(SpamSlayer) that runs on my telephone line to answer, record,
and log calls received at my number. The system operates only
on calls placed to me; it does not place outbound calls and
does not solicit calls.

Regarding the call recordings and transcripts attached as
exhibits: ${(() => {
  const recN = offender.calls.filter((c) => c.recordingUrl).length;
  if (recN === 0) {
    return `there are no audio recordings for this matter; all
calls are documented by call-detail records only. Call-detail
records (date, time, originating number, duration) were captured
contemporaneously by my compliance system and are independently
corroborated by my carrier's Call Detail Records.`;
  }
  const reviewClause = recN <= 5
    ? (recN === 1
        ? `I have personally reviewed the ${recN} recording and its
transcript in their entirety.`
        : `I have personally reviewed each of the ${recN} recordings
and their transcripts in their entirety.`)
    : `I have had a full opportunity to review each recording
and transcript, and I have personally reviewed representative
samples drawn from the set.`;
  return `${reviewClause} The recordings were automatically
captured by my compliance system at the time of each call and
stored on the Twilio telecommunications platform, a third-party
service provider. To the best of my knowledge, I have not
altered any recording since capture, and the recordings
accurately represent the calls as received at my telephone
number. The recordings are authenticated through SHA-256
cryptographic hashes generated at the time of capture, and
each recording's integrity can be independently verified from
the accompanying Integrity Certificate (Exhibit).`;
})()}

Executed on __________________, 20____, at
${config.userCity}, ${config.courtState}.


____________________________________
${config.userName}


CERTIFICATION OF PRO SE STATUS

I, ${config.userName}, certify that I am representing myself in
this matter without the assistance of an attorney (in proper
person) and that I understand my obligations as a self-represented
litigant in small claims court.


____________________________________
${config.userName}
Date: __________________
`;
}

// ─────────────────────────────────────────────────────────────────────────────
//  2. EVIDENCE EXHIBIT LIST
// ─────────────────────────────────────────────────────────────────────────────

function generateExhibitList(
  offender: OffenderProfile,
  config: FilingConfig,
  caseRef: string,
  generatedAt: Date
): string {
  const company = getDefendantName(offender);
  const today = generatedAt.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });

  const nextLetter = createExhibitLabeler();

  const exhibits: Array<{ letter: string; title: string; description: string }> = [];

  // Exhibit A: DNC Registry confirmation
  exhibits.push({
    letter: nextLetter(),
    title: "National Do Not Call Registry Confirmation",
    description:
      `Printout from donotcall.gov confirming that telephone number\n` +
      `    ${config.userPhone} has been registered on the National Do Not Call\n` +
      `    Registry since ${config.dncRegistrationDate}.\n` +
      `    → HOW TO GET THIS: Go to https://www.donotcall.gov/verify.html\n` +
      `      and enter your phone number. Print or screenshot the result.`,
  });

  // Exhibit B: Complete call log
  exhibits.push({
    letter: nextLetter(),
    title: "SpamSlayer Call Log — All Calls from Defendant",
    description:
      `Complete system-generated log of ${offender.callCount} call(s) from\n` +
      `    ${offender.rawNumbers.join(", ")} (${company}):\n\n` +
      buildCallLogTable(offender.calls),
  });

  // Individual recording exhibits
  const recordedCalls = offender.calls.filter((c) => c.recordingUrl);
  recordedCalls.forEach((call) => {
    exhibits.push({
      letter: nextLetter(),
      title: `Call Recording — ${formatDate(call.date)} at ${call.time}`,
      description:
        `Audio recording of call on ${formatDate(call.date)} at ${call.time}.\n` +
        `    Call SID: ${call.callSid}\n` +
        `    Recording URL: ${call.recordingUrl}\n` +
        `    Recorded under ${config.stateRecordingLaw}.\n` +
        `    → IMPORTANT: Download this recording to your computer and save\n` +
        `      to USB drive. Twilio recording URLs may expire. Do NOT rely\n` +
        `      on the URL being accessible at trial.\n` +
        `    → Provide recordings to the court on USB drive or CD.\n` +
        `    → Authentication: This recording was automatically captured by\n` +
        `      SpamSlayer's compliance system at the time of the call.`,
    });
  });

  // Transcript exhibit
  const callsWithTranscripts = offender.calls.filter((c) => c.transcriptSnippet);
  if (callsWithTranscripts.length > 0) {
    const transcriptText = callsWithTranscripts
      .map(
        (c, i) =>
          `    Call ${i + 1} (${formatDate(c.date)} ${c.time}):\n` +
          `    "${sanitizeTranscript(c.transcriptSnippet)}"`
      )
      .join("\n\n");

    exhibits.push({
      letter: nextLetter(),
      title: "Call Transcripts (Reference Only)",
      description:
        `Transcripts of recorded calls with Defendant:\n\n${transcriptText}\n\n` +
        `    TRANSCRIPT METHODOLOGY: These transcripts were generated by\n` +
        `    automated speech-to-text processing and are provided as a\n` +
        `    convenience reference only. They may contain minor transcription\n` +
        `    errors. The court should rely on the original audio recordings\n` +
        `    (attached as separate exhibits) for the authoritative record\n` +
        `    of what was said during each call.\n\n` +
        `    Sensitive information (account numbers, etc.) has been redacted.\n` +
        `    Full unredacted recordings are available for in camera review\n` +
        `    upon request.`,
    });
  }

  // Demand letter exhibit (if sent)
  if (offender.demandLetterSent && offender.demandLetterDate) {
    exhibits.push({
      letter: nextLetter(),
      title: "Demand Letter and Certified Mail Receipt",
      description:
        `Copy of demand letter sent to Defendant on\n` +
        `    ${formatDate(offender.demandLetterDate)} via certified mail,\n` +
        `    together with the USPS certified mail receipt and return\n` +
        `    receipt (green card) if received.\n` +
        `    → Attach your copy of the letter AND the postal receipts.\n` +
        `    → This exhibit supports willful violation and treble damages.`,
    });
  }

  // Carrier Call Detail Records (CDR) exhibit — independent corroboration
  exhibits.push({
    letter: nextLetter(),
    title: "Carrier Call Detail Records (CDR)",
    description:
      `Independent call records from Plaintiff's telephone carrier\n` +
      `    corroborating incoming calls from:\n` +
      `    ${offender.rawNumbers.join(", ")}\n` +
      `    on the following dates: ${offender.calls.map((c) => c.date).join(", ")}.\n\n` +
      `    Carrier CDRs are the STRONGEST corroborating evidence because\n` +
      `    they are generated by a neutral third party (your phone company)\n` +
      `    with no connection to your compliance system or Twilio.\n\n` +
      `    → HOW TO GET YOUR CDRs:\n\n` +
      `      OPTION 1 — ONLINE (fastest, free):\n` +
      `        Most carriers let you download call history online:\n` +
      `        • AT&T:     att.com → My AT&T → Usage → Call History\n` +
      `        • T-Mobile:  t-mobile.com → Usage → Call Details\n` +
      `        • Verizon:  verizonwireless.com → My Usage → View Usage\n` +
      `        • Sprint:   sprint.com → My Sprint → My Usage\n` +
      `        Download or screenshot the records showing the spam calls.\n` +
      `        Print the pages with the matching dates highlighted.\n\n` +
      `      OPTION 2 — REQUEST FORMAL CDRs (more authoritative):\n` +
      `        Call your carrier's customer service and request:\n` +
      `        "I need a formal Call Detail Record report for my number\n` +
      `         ${config.userPhone} covering ${offender.firstCallDate} through\n` +
      `         ${offender.lastCallDate}. This is for use as evidence in a\n` +
      `         court proceeding."\n` +
      `        Carriers are required to provide customers access to their\n` +
      `        own call records. Some carriers charge a small fee ($5-$25)\n` +
      `        for formal CDRs. Formal CDRs typically include: originating\n` +
      `        number, date, time, duration, and call type.\n\n` +
      `        ⚠ RETENTION WARNING: Most carriers retain CDRs for only\n` +
      `        18-24 months. If your earliest calls are older than 18\n` +
      `        months, request CDRs IMMEDIATELY before they are purged.\n` +
      `        If CDRs have already been purged, your phone bill\n` +
      `        screenshots and Twilio logs still serve as evidence.\n\n` +
      `      OPTION 3 — SUBPOENA DEFENDANT'S CARRIER (advanced):\n` +
      `        If the defendant disputes making the calls, you can\n` +
      `        subpoena the defendant's phone carrier to produce THEIR\n` +
      `        outbound call records showing calls to your number.\n` +
      `        Ask the clerk about issuing a subpoena duces tecum.\n` +
      `        This is usually only needed if the defendant shows up\n` +
      `        and denies making the calls.\n\n` +
      `    → WHAT THE CDR PROVES:\n` +
      `      • The calls actually happened (independent of your system)\n` +
      `      • The exact dates and times match your petition\n` +
      `      • The originating phone number matches the defendant\n` +
      `      • The call duration confirms a connection was made\n` +
      `      • Your carrier has no motive to fabricate records`,
  });

  // Evidence authentication exhibit
  if (recordedCalls.length > 0) {
    exhibits.push({
      letter: nextLetter(),
      title: "Recording Authentication Declaration",
      description:
        `Declaration of Plaintiff authenticating all call recordings:\n\n` +
        `    I, ${config.userName}, declare under penalty of perjury:\n\n` +
        `    1. I am the subscriber of telephone number ${config.userPhone}.\n` +
        `    2. Each recording attached as an exhibit was automatically\n` +
        `       captured at the time of the call by the telephone\n` +
        `       compliance system (SpamSlayer) that I installed and\n` +
        `       configured to answer and record calls placed to my\n` +
        `       number, and was stored on the Twilio telecommunications\n` +
        `       platform.\n` +
        `    3. To the best of my knowledge, I have not edited, spliced,\n` +
        `       altered, or manipulated any recording file since capture,\n` +
        `       nor directed anyone else to do so.\n` +
        `    4. Each recording's SHA-256 hash was computed at the time of\n` +
        `       capture and can be independently verified against the\n` +
        `       accompanying Evidence Integrity Certificate. Any party\n` +
        `       may recompute the hash from the audio file and confirm\n` +
        `       it matches the value recorded in the certificate.\n` +
        (recordedCalls.length <= 5
          ? `    5. I have personally reviewed each of the ${recordedCalls.length} recording${recordedCalls.length === 1 ? "" : "s"}\n` +
            `       after capture. Each recording matches the audio file as\n` +
            `       stored on the Twilio platform and faithfully captures the\n` +
            `       audio as received at my telephone number. I am not aware\n` +
            `       of any recording that has been altered.\n`
          : `    5. I have had a full opportunity to review each recording\n` +
            `       after capture and have personally reviewed representative\n` +
            `       samples. The recordings I have reviewed match the audio\n` +
            `       files as stored on the Twilio platform and faithfully\n` +
            `       capture the audio as received at my telephone number.\n` +
            `       I am not aware of any recording that has been altered.\n`) +
        // AUDIT_ROUND_17 CRIT-2: config.stateRecordingLaw often already
        // carries the trailing "(one-party consent)" parenthetical (the
        // default value is "La. R.S. 15:1303 (one-party consent)"), so we
        // strip any trailing "(one/two-party consent)" off the citation
        // before rendering and then add the descriptor exactly once.
        `    6. The recordings comply with ${stripRecordingLawParen(config.stateRecordingLaw)}\n` +
        `       (one-party consent state law) and 18 U.S.C. § 2511(2)(d)\n` +
        `       (federal one-party consent).\n\n` +
        `    → BEFORE SIGNING: If any statement above is not accurate for\n` +
        `      your situation (for example, if you have not yet reviewed\n` +
        `      the recording(s), or if you know of any file that has been\n` +
        `      altered), STOP and correct the statement before signing.\n` +
        `      Signing a false declaration is perjury.\n` +
        `    → SIGN AND DATE this declaration before filing.\n` +
        `    → This exhibit authenticates your recordings under La. Code\n` +
        `      of Evidence Art. 901(A) and Fed. R. Evid. 901(a).`,
    });
  }

  // Corroborating evidence exhibit — third-party verification
  exhibits.push({
    letter: nextLetter(),
    title: "Third-Party Corroborating Evidence",
    description:
      `Corroborating records from Plaintiff's telecommunications\n` +
      `    service provider verifying the calls at issue:\n\n` +
      `    1. TWILIO CALL RECORDS: Each call was routed through Twilio,\n` +
      `       a publicly traded telecommunications platform (NYSE: TWLO)\n` +
      `       that independently logs all calls processed through its\n` +
      `       system. Twilio assigns a unique Call SID to each call.\n` +
      `       These records are available via discovery or subpoena to\n` +
      `       Twilio, Inc. if Defendant disputes authenticity. Call SIDs\n` +
      `       for this case:\n` +
      offender.calls.map((c, i) =>
        `         ${i + 1}. ${c.callSid || "N/A"} (${c.date} ${c.time})`
      ).join("\n") + `\n\n` +
      `    2. CARRIER CALL DETAIL RECORDS (CDRs): Plaintiff's telephone\n` +
      `       carrier independently logged each incoming call from\n` +
      `       ${offender.rawNumbers.join(", ")}. Carrier CDRs are generated\n` +
      `       by a neutral third party with no connection to Plaintiff's\n` +
      `       compliance system. CDRs are attached as a separate exhibit\n` +
      `       and are independently verifiable through the carrier.\n\n` +
      `    3. CRYPTOGRAPHIC HASHES: Each recording was signed with a\n` +
      `       SHA-256 hash at the time of capture, providing tamper-proof\n` +
      `       verification. See Evidence Integrity Certificate.\n\n` +
      `    These three corroborating sources — Twilio platform records\n` +
      `    (available via subpoena), carrier Call Detail Records\n` +
      `    (obtainable by Plaintiff from their own carrier),\n` +
      `    and cryptographic signatures — independently corroborate\n` +
      `    the SpamSlayer system logs. Each source is generated by a\n` +
      `    different entity with no shared motive to fabricate,\n` +
      `    establishing the authenticity of the digital evidence\n` +
      `    beyond reasonable dispute.`,
  });

  // Evidence Integrity Certificate exhibit — dedicated exhibit for hashes
  if (recordedCalls.length > 0) {
    exhibits.push({
      letter: nextLetter(),
      title: "Evidence Integrity Certificate (SHA-256 Hashes)",
      description:
        `Cryptographic integrity certificate for all call recordings.\n\n` +
        `    WHAT THIS IS: At the time each call was recorded, the\n` +
        `    SpamSlayer compliance system computed a SHA-256 hash (a\n` +
        `    unique digital fingerprint) of the recording file. If the\n` +
        `    recording were altered in any way — even a single second of\n` +
        `    audio — the fingerprint would be completely different.\n\n` +
        `    SHA-256 is a federal standard (FIPS 180-4) used by the U.S.\n` +
        `    government for securing classified documents and is widely\n` +
        `    accepted in federal and state courts for digital evidence\n` +
        `    authentication.\n\n` +
        `    → Attach the Evidence Integrity Certificate generated by\n` +
        `      SpamSlayer (generated automatically with this filing).\n` +
        `    → The certificate lists each recording's hash, the date it\n` +
        `      was computed, and a master hash of the complete evidence set.\n` +
        `    → To verify: run "sha256sum <recording_file>" on any computer\n` +
        `      and compare the output to the hash in the certificate.\n\n` +
        `    NOTE: These hashes were generated by Plaintiff's own system\n` +
        `    and stored locally. They prove the recordings have not been\n` +
        `    altered SINCE capture, but do not independently verify the\n` +
        `    source of the recordings. The recordings' authenticity is\n` +
        `    corroborated by the separate carrier CDRs and Twilio\n` +
        `    platform records listed in other exhibits.`,
    });
  }

  // Damages calculation exhibit — must match petition's amount.
  // Uses the same authoritative helper as the petition and the validator.
  const damagesBreakdown = computeExpectedDamages(offender);
  const rawDamages = offender.damagesEstimate;
  const { cappedDamages: exhibitCappedDamages, wasCapped: exhibitWasCapped } =
    computeCappedDamages(rawDamages, config.smallClaimsLimit);

  const breakdownLines = damagesBreakdown.isSplit
    ? `    Pre-demand violations:   ${damagesBreakdown.standardCalls} × ` +
      `$${damagesBreakdown.standardRate.toLocaleString()} = ` +
      `$${(damagesBreakdown.standardCalls * damagesBreakdown.standardRate).toLocaleString()}\n` +
      `    Post-demand willful:     ${damagesBreakdown.willfulCalls} × ` +
      `$${damagesBreakdown.willfulRate.toLocaleString()} = ` +
      `$${(damagesBreakdown.willfulCalls * damagesBreakdown.willfulRate).toLocaleString()}\n`
    : `    Violations:              ${offender.callCount}\n` +
      `    Rate per violation:      $${
        damagesBreakdown.willfulCalls > 0
          ? damagesBreakdown.willfulRate.toLocaleString() + " (treble — willful)"
          : damagesBreakdown.standardRate.toLocaleString() + " (standard)"
      }\n`;

  exhibits.push({
    letter: nextLetter(),
    title: "Damages Calculation",
    description:
      `Statutory damages under 47 U.S.C. § 227(c)(5):\n\n` +
      breakdownLines +
      `    Calculated damages:      $${rawDamages.toLocaleString()}\n` +
      `${exhibitWasCapped
        ? `    Small claims cap:        ${formatMoneyCap(config.smallClaimsLimit)}\n` +
          `    Amount requested:        $${exhibitCappedDamages.toLocaleString()} (excess waived)\n`
        : `    Amount requested:        $${rawDamages.toLocaleString()}\n`}` +
      `\n    Calculation: ${damagesBreakdown.isSplit
        ? `${damagesBreakdown.standardCalls} pre-demand calls × $${damagesBreakdown.standardRate.toLocaleString()} + ` +
          `${damagesBreakdown.willfulCalls} post-demand calls × $${damagesBreakdown.willfulRate.toLocaleString()}`
        : `${offender.callCount} calls × $${
            damagesBreakdown.willfulCalls > 0
              ? damagesBreakdown.willfulRate.toLocaleString()
              : damagesBreakdown.standardRate.toLocaleString()
          }/violation`} = $${rawDamages.toLocaleString()}\n` +
      `${exhibitWasCapped
        ? `\n    Plaintiff voluntarily reduces the claim to ${formatMoneyCap(config.smallClaimsLimit)}\n` +
          `    to remain within this Court's jurisdictional limit.\n`
        : ""}` +
      `${damagesBreakdown.willfulCalls > 0
        ? `\n    Treble damages apply ONLY to calls placed AFTER the\n` +
          `    cease-and-desist demand was received (${damagesBreakdown.willfulCalls} of\n` +
          `    ${offender.callCount} total calls). Pre-demand calls are claimed\n` +
          `    at the standard statutory rate of $${damagesBreakdown.standardRate.toLocaleString()}/violation,\n` +
          `    because trebling under 47 U.S.C. § 227(c)(5)(B) requires a\n` +
          `    willful or knowing violation — which, as to pre-demand calls,\n` +
          `    would be more difficult to prove without a prior notice.`
        : ""}`,
  });

  // Format the full exhibit list document
  let doc = `═══════════════════════════════════════════════════════════════════════
                         EXHIBIT LIST
═══════════════════════════════════════════════════════════════════════

Case:       ${config.userName} v. ${company}
Court:      ${config.courtName}
Ref:        ${caseRef}
Date:       ${today}

───────────────────────────────────────────────────────────────────────

`;

  exhibits.forEach((ex) => {
    doc += `EXHIBIT ${ex.letter}: ${ex.title}\n\n    ${ex.description}\n\n`;
    doc += `───────────────────────────────────────────────────────────────────────\n\n`;
  });

  doc += `Total Exhibits: ${exhibits.length}\n\n`;
  doc += `I certify that the above exhibits are true and accurate records.\n\n`;
  doc += `____________________________________\n`;
  doc += `${config.userName}\n`;
  doc += `${today}\n`;

  return doc;
}

// ─────────────────────────────────────────────────────────────────────────────
//  3. CERTIFICATE OF SERVICE
// ─────────────────────────────────────────────────────────────────────────────

function generateCertificateOfService(
  offender: OffenderProfile,
  config: FilingConfig,
  caseRef: string,
  generatedAt: Date
): string {
  const company = getDefendantName(offender);
  const today = generatedAt.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });

  return `═══════════════════════════════════════════════════════════════════════
                     CERTIFICATE OF SERVICE
═══════════════════════════════════════════════════════════════════════

Case:       ${config.userName} v. ${company}
Court:      ${config.courtName}
Ref:        ${caseRef}

───────────────────────────────────────────────────────────────────────

I, ${config.userName}, hereby certify that on __________________ (date),
a true and correct copy of the following documents:

    1. Small Claims Petition
    2. Exhibit List and all referenced exhibits
    3. This Certificate of Service

were served upon the Defendant:

    ${company}
    Address: ________________________________________________
    Phone:   ${offender.rawNumbers[0] ?? offender.normalizedNumber}

by the following method (check one — see La. R.S. 13:5204).
IMPORTANT: if the Defendant is a corporation or LLC, service must be made
on its registered agent — not on the marketing phone line shown above.
Use the lookup instructions in "NOTE ON SERVING SPAMMERS" below to find
the agent's name and address BEFORE selecting a service method.

    [ ] Certified Mail, Return Receipt Requested
        USPS Tracking Number: ________________________________
        (For a corporate defendant, addressed to the registered agent)

    [ ] Personal Service (by constable or process server)
        Server Name: _________________________________________
        Date/Time of Service: ________________________________
        (For a corporate defendant, served on the registered agent)

    [ ] Service Arranged by the Court
        (Some courts handle service for you — ask the clerk)
        Court tracking number: _______________________________


NOTE ON SERVING SPAMMERS:
─────────────────────────
If you do not have the Defendant's physical address, you have
several options:

    1. REVERSE PHONE LOOKUP: Search the caller's phone number on
       services like TrueCaller, Whitepages, or the FCC's TCPA
       complaint database to find the registered business.

    2. FCC COMPLAINT DATABASE: File a complaint at
       https://consumercomplaints.fcc.gov and the FCC may have
       the company's registered address.

    3. STATE BUSINESS REGISTRY: If you have the company name,
       search your state's Secretary of State business registry
       for their registered agent and address. In Louisiana:
       https://www.sos.la.gov/BusinessServices

    4. SKIP TRACING: The court clerk can sometimes help with
       locating defendants for service.

    5. SERVICE BY PUBLICATION: If you truly cannot locate the
       Defendant after diligent effort, ask the clerk about
       service by publication under La. C.C.P. Art. 1263 or
       other alternative service methods under
       La. C.C.P. Art. 1261 et seq.

    6. REGISTERED AGENT: If Defendant is a corporation or LLC,
       they are required to have a registered agent for service
       of process in every state where they do business.

───────────────────────────────────────────────────────────────────────

Signed this __________ day of __________________, 20____


____________________________________
${config.userName}
${config.userAddress}
${config.userCity}, ${config.courtState} ${config.userZip}
${config.userPhone}`;
}

// ─────────────────────────────────────────────────────────────────────────────
//  4. PLAIN-ENGLISH FILING GUIDE
// ─────────────────────────────────────────────────────────────────────────────

function generateFilingGuide(
  offender: OffenderProfile,
  config: FilingConfig,
  caseRef: string,
  warnings: string[],
  generatedAt: Date
): string {
  const company = getDefendantShortName(offender);
  const totalDamages = offender.damagesEstimate;
  const { cappedDamages: guideCappedDamages, wasCapped: guideWasCapped } =
    computeCappedDamages(totalDamages, config.smallClaimsLimit);

  const warningsBlock = warnings.length > 0
    ? `\n═══════════════════════════════════════════════════════════════════════\n\n` +
      `IMPORTANT WARNINGS — READ BEFORE FILING\n` +
      `────────────────────────────────────────\n\n` +
      warnings.map((w) => `    ⚠ ${w}`).join("\n\n") +
      `\n`
    : "";

  return `═══════════════════════════════════════════════════════════════════════
        SPAMSLAYER FILING GUIDE — YOUR STEP-BY-STEP PLAYBOOK
═══════════════════════════════════════════════════════════════════════

Case Ref:      ${caseRef}
Defendant:     ${company}
Your Damages:  $${guideCappedDamages.toLocaleString()}${guideWasCapped ? ` (capped from $${totalDamages.toLocaleString()} to fit small claims limit)` : ""}
Court:         ${config.courtName}
               ${config.courtAddress}
               ${config.courtCity}, ${config.courtState} ${config.courtZip}
Clerk Phone:   ${config.courtClerkPhone}
${warningsBlock}
═══════════════════════════════════════════════════════════════════════

YOU CAN DO THIS
───────────────

    If you're feeling nervous about going to court — that's normal.
    Small claims court is specifically designed for regular people
    without lawyers. The judge and clerk are used to helping self-
    represented people. You don't need to memorize legal terms or
    give a perfect speech. Just bring your evidence, tell the truth,
    and let the documents do the heavy lifting.

    Here's what you need to know about logistics:
    → No appointment needed — just walk in during business hours
      (typically 8:30 AM - 4:30 PM, Mon-Fri — call to confirm)
    → Dress neatly (business casual is fine — no suit required)
    → You can bring a friend or family member for support
    → The whole process usually takes 15-30 minutes
    → If you can't take off work, ask the clerk about afternoon
      or alternative scheduling
    → You will NOT owe the defendant money if you lose — small
      claims courts don't award costs to defendants in most cases
    → If you can't afford the filing fee, ask the clerk about a
      "fee waiver" or "in forma pauperis" application — courts
      can waive fees for people with limited income

═══════════════════════════════════════════════════════════════════════

IMPORTANT — COURT FORM CHECK
─────────────────────────────

    Some Louisiana courts use their own pre-printed small claims
    forms instead of accepting written petitions. BEFORE printing
    all these documents, call the clerk at ${config.courtClerkPhone}
    and ask: "Does ${config.courtName} accept written small claims
    petitions, or do I need to use the court's own form?" If they
    require their form, you can use SpamSlayer's petition as your
    reference — copy the information into the court's form.

BEFORE YOU FILE — CHECKLIST
───────────────────────────

    [ ] Fill in your personal info in ALL documents if you see
        brackets like [YOUR NAME]
    [ ] Verify your DNC registration at https://www.donotcall.gov/verify.html
        and print/screenshot the confirmation
    [ ] GET YOUR CARRIER CALL RECORDS — this is your strongest
        independent evidence. Log into your carrier's website (AT&T,
        T-Mobile, Verizon, etc.) and download/screenshot your call
        history showing the spam calls. For formal CDRs, call your
        carrier and request a Call Detail Record report. See the
        Exhibit List for detailed instructions.
    [ ] CRITICAL: Download recordings to your computer NOW — Twilio
        may auto-delete recordings after 30 days. Do NOT rely on
        recording URLs being available at trial. Save as MP3/WAV
        files and back up to USB drive.
    [ ] Make sure recordings are saved (USB drive — not just URLs)
    ${offender.demandLetterSent
      ? "[ ] Gather your demand letter copy and certified mail receipt"
      : "[ ] RECOMMENDED: Send a demand letter first (SpamSlayer can\n        generate one). This strengthens your case AND can trigger\n        treble damages ($1,500/call) if they keep calling."}
    [ ] VERIFY the phone number actually belongs to the defendant —
        spoofed caller IDs are common. Search the number on
        TrueCaller or FreeCarrierLookup.com. If it's a VoIP/
        disposable number, verify the company name from recordings.
    [ ] Confirm you have NO prior business relationship with ${company}
        (no purchases, no inquiries, no accounts)
    [ ] Confirm you never gave them written permission to call you
    [ ] CRITICAL: Make sure the defendant's LEGAL BUSINESS NAME is
        in the petition (not just a phone number). Courts cannot
        enter judgment against "Unknown Entity" — you must identify
        the company. Search the phone number on TrueCaller,
        Whitepages, or your state's Secretary of State business
        registry to find the registered business name.
    [ ] Sign the Recording Authentication Declaration (Exhibit)
    [ ] Sign the Verification at the end of the Petition

═══════════════════════════════════════════════════════════════════════

STEP 1: PREPARE YOUR DOCUMENTS
───────────────────────────────

SpamSlayer generated 3 documents for you:

    a) PETITION — This is your lawsuit. It tells the court what
       happened and what you're asking for.

    b) EXHIBIT LIST — This is your evidence inventory. It tells
       the court (and the defendant) exactly what proof you have.

    c) CERTIFICATE OF SERVICE — This proves you gave the defendant
       a copy of everything. The court requires this.

Print 3 COPIES of everything:
    → 1 for the court (they keep this)
    → 1 for the defendant (you serve this)
    → 1 for you (your records)

═══════════════════════════════════════════════════════════════════════

STEP 2: GO TO THE COURTHOUSE
─────────────────────────────

Go to:  ${config.courtName}
        ${config.courtAddress}
        ${config.courtCity}, ${config.courtState} ${config.courtZip}

Tell the clerk:
    "I'd like to file a small claims petition."

They will:
    → Take your petition and exhibits
    → Assign a case number (write this on ALL your copies)
    → Collect the filing fee (approximately ${config.filingFee} —
      CALL ${config.courtClerkPhone} FIRST to confirm the current
      amount and accepted payment methods)
    → Give you a court date (usually 2-4 weeks out)

═══════════════════════════════════════════════════════════════════════

STEP 3: SERVE THE DEFENDANT
────────────────────────────

The defendant must receive a copy of your petition before the
court date. Louisiana law requires proper service under
La. R.S. 13:5204 (service of small-claims citation).

FIRST, ASK THE CLERK: "Will the court handle service, or do I
need to arrange it myself?" Some courts handle service for you.

IF YOU ARRANGE SERVICE YOURSELF — Certified mail is easiest:
    → Go to the post office
    → Send copies via Certified Mail with Return Receipt Requested
    → Cost: about ${config.serviceFee}
    → Keep the green receipt card — this is your PROOF of service
    → Fill in the tracking number on your Certificate of Service

NOTE: Small claims service is limited to certified mail or
personal service (constable/process server). Other methods
like domiciliary service are NOT available in small claims.

If you don't have their address, see the tips in the Certificate
of Service document.

═══════════════════════════════════════════════════════════════════════

NOTE: POSSIBLE SETTLEMENT CONFERENCE
─────────────────────────────────────

    Some Louisiana courts schedule a settlement conference or
    mediation session before the trial date (this is done by
    individual court rule, not statute — check your court's
    local rules and the notice you receive). If the court
    contacts you about a conference:
    → Attend — failure to appear may delay or dismiss your case
    → Bring all your evidence (same as for trial)
    → The defendant may offer to settle (see Settlement
      Negotiation guidance in the Courtroom Preparation section)
    → If no settlement is reached, the case proceeds to trial
    → If the defendant doesn't show for the conference, ask the
      judge about entering a default judgment

═══════════════════════════════════════════════════════════════════════

STEP 4: SHOW UP TO COURT
─────────────────────────

What to bring:
    → Your copy of everything (petition, exhibits, certificate)
    → Your phone (to play recordings if needed)
    → USB drive with recordings (backup)
    → Carrier call detail records (CDRs) showing the spam calls
    → Your phone bill showing the calls (if separate from CDRs)
    → DNC registry printout
    ${offender.demandLetterSent ? "→ Demand letter copy and certified mail receipt" : ""}

What to say (keep it simple):
    "Your Honor, I'm on the Do Not Call Registry. The defendant
     called me ${offender.callCount} times between ${formatDate(offender.firstCallDate)}
     and ${formatDate(offender.lastCallDate)}. I have recordings and phone
     records proving each call. Under the TCPA, I'm entitled to
     $${offender.willful ? "1,500" : "500"} per violation. I'm requesting $${guideCappedDamages.toLocaleString()}."

Then show your evidence when the judge asks.

IMPORTANT: The defendant probably WON'T show up. Most spammers
ignore small claims suits. If they don't appear, you can get a
DEFAULT JUDGMENT — but it is NOT automatic. You must:
    → Show the judge your proof of service (certified mail receipt
      or constable's return) to prove the defendant was properly
      notified
    → Ask the clerk: "How do I request a default judgment?" — some
      courts require a written Motion for Default Judgment
    → You may still need to briefly present your evidence (damages
      amount, basis for the claim) even without the defendant
    → The judge then enters judgment in your favor

═══════════════════════════════════════════════════════════════════════

WHAT IF THEY FIGHT BACK? — COMMON DEFENSES
───────────────────────────────────────────

Your petition already addresses these, but here's what to expect:

    1. "WE HAVE A SAFE HARBOR" — They'll claim they scrubbed
       their list against the DNC registry. Your response:
       "If they had proper procedures, they wouldn't have called
       a DNC-registered number ${offender.callCount} times. Ask them to
       produce their written DNC policy and proof of 31-day
       registry scrubbing. The burden is on them."

    2. "WE HAD AN ESTABLISHED BUSINESS RELATIONSHIP" — They'll
       claim you bought something from them or made an inquiry.
       Your response: "I have never done business with this
       company. Ask them to produce a receipt, transaction record,
       or signed agreement. They can't, because none exists."

    3. "YOU CONSENTED TO OUR CALLS" — They'll claim you signed up.
       Your response: "I never provided written consent to receive
       calls from this company. Ask them to produce a signed
       consent form or a recording of verbal consent. The burden
       of proving consent is on the defendant."

    4. "AN AI ANSWERED, NOT A PERSON — NO HARM" — This is their
       flashiest argument, but it fails. Your response:
       "I am the telephone subscriber. The TCPA protects my right
       to be free from unsolicited calls to my DNC-registered
       number. The statute says 'a person who has received more
       than one telephone call' — I received these calls at MY
       number. How I choose to answer my own phone doesn't give
       telemarketers permission to call a Do Not Call number.
       My compliance system is my authorized agent, just like an
       answering machine or a secretary. The calls consumed my
       phone line, triggered my infrastructure, and invaded my
       privacy. See Spokeo v. Robins — TCPA violations are
       concrete injuries regardless of the answering mechanism."

    5. "WE DIDN'T KNOW WE WERE VIOLATING THE LAW" — Irrelevant.
       Liability under 47 U.S.C. § 227(c)(5) does not require
       intent — it's a strict liability statute for the base
       $500 damages. Intent only matters for treble damages.

    6. "YOUR SYSTEM KEPT US ON THE LINE — ENTRAPMENT" — Nonsense.
       Your response: "Entrapment is a criminal defense that only
       applies to government agents. I'm a private citizen. More
       importantly, the violation occurred the moment you dialed
       my DNC-registered number — not during the conversation.
       Whether the call lasted 5 seconds or 5 minutes, the
       violation is the same. The recording simply captured
       evidence of a violation that was already in progress."

    7. "THIS IS A PROFESSIONAL PLAINTIFF / LITIGATION FACTORY" —
       They'll try to paint you as someone who sets up these cases
       for profit. DEFENSE COUNSEL MAY CITE:
         • Stoops v. Wells Fargo, 197 F. Supp. 3d 782 (W.D. Pa.
           2016) — plaintiff bought dozens of cell phones, sat in
           a rocking chair waiting for spam calls; court held
           she lacked Article III standing because TCPA's
           "privacy" interest was not invaded when she wanted
           the calls.
         • In re Nomorobo Honeypot Litig. (2026) — held that
           operators of commercial honeypot lines whose ONLY
           purpose was to attract and sue spam calls lacked
           standing.
       Your response:
       "Stoops and Nomorobo are distinguishable. (1) This is my
       personal residential/business cell phone, not a number
       acquired solely to generate lawsuits. I use it for real
       communication every day. (2) I registered on the DNC list
       BECAUSE I don't want spam calls — the record shows my
       system's only interaction with telemarketers is to warn
       them off and end the call. (3) The TCPA's privacy
       interest IS invaded here: these calls tie up my line,
       trigger notifications on my phone, and consume my time.
       Congress specifically created the § 227(c)(5) private
       right of action so residential subscribers like me could
       enforce the DNC registry. Using a compliance tool to
       document violations is no different from installing a
       security camera to record a trespasser — the camera
       doesn't cause the trespass."

    8. "UNCLEAN HANDS / YOU TRICKED US INTO STAYING ON THE LINE" —
       They'll argue your system manipulated the conversation.
       Your response: "The violation happened when you dialed my
       number, before any conversation took place. My compliance
       system simply answered the phone — exactly like voicemail
       or an answering machine would. The conversation that
       followed is evidence of the violation, not the cause of it.
       Unclean hands requires that I did something wrong related
       to the lawsuit — answering my own phone and recording in a
       one-party consent state is perfectly legal. And my system
       delivered a DNC warning during the call, giving you notice
       to stop calling — which you ignored."

    9. "THOSE CALLS WEREN'T FROM US / WE USE SUBCONTRACTORS" —
       They'll claim a third party made the calls or different
       phone numbers mean different entities. Your response:
       "The TCPA says 'by or on behalf of the same entity.' If
       you hired someone to make these calls, you're still liable.
       The calls all had the same purpose, the same pitch, and
       came from numbers traceable to your organization. You can't
       outsource your way out of TCPA liability. Ask them to
       produce their calling vendor contracts — that proves they
       directed the calls."

   10. "THOSE WEREN'T TELEMARKETING CALLS" — They'll claim the
       calls were surveys, informational, or debt collection (not
       covered by the DNC provisions). Your response: "Listen to
       the recordings. The caller was selling [product/service].
       The TCPA defines 'telephone solicitation' as any call to
       encourage purchase of goods or services. The content of
       these calls is commercial solicitation, period. If they
       claim it was debt collection, ask them to produce the debt
       — there isn't one, because I've never done business with
       this company."

   11. "THIS IS A BUSINESS LINE, NOT RESIDENTIAL" — They'll argue
       your phone is used for business and TCPA DNC rules only
       protect residential numbers. Your response: "My number is
       my personal residential telephone number. I may occasionally
       use my phone for incidental purposes, but it is registered
       to my home address and is my primary residential line. The
       DNC Registry does not distinguish between phones that are
       sometimes used for personal business and dedicated business
       lines."

   12. "WE'RE REMOVING THIS TO FEDERAL COURT" — They'll try to
       move the case out of small claims into federal court (where
       you'd need a lawyer). This is rare but legally possible
       because the TCPA is a federal statute. A defendant can file
       a notice of removal under 28 U.S.C. § 1441(a) (federal
       question jurisdiction) — the $75,000 diversity threshold
       does NOT apply here because the TCPA claim arises under
       federal law. However, most defendants won't bother because:
       (a) it costs them more in attorney fees than the claim is
       worth, (b) they face the same unfavorable TCPA law in
       federal court, and (c) the judge may look unfavorably on a
       corporation trying to bully a pro se consumer out of small
       claims. IF the defendant does remove: you must file a
       "Motion to Remand" within 30 DAYS (28 U.S.C. § 1447(c))
       arguing that state courts have concurrent jurisdiction
       under Mims v. Arrow Financial, 565 U.S. 368 (2012), and
       that Congress expressly authorized suit in state court
       under 47 U.S.C. § 227(c)(5). IMPORTANT: If the case is
       removed to federal court, CONSULT AN ATTORNEY — federal
       court procedures are significantly more complex than small
       claims and you may need legal representation.

═══════════════════════════════════════════════════════════════════════

COURTROOM PREPARATION — WHAT YOU NEED TO KNOW
──────────────────────────────────────────────

HOW TO AUTHENTICATE YOUR RECORDINGS IN COURT:
    A written declaration alone may not be enough. The judge will
    likely want you to TESTIFY about the recordings. Here's your
    script:

    Judge: "How do I know these recordings are real?"

    You: "Your Honor, I am the telephone subscriber for the number
    that was called. I authorized my telephone compliance system —
    which works like an answering machine — to answer and record
    incoming calls on my behalf. The recordings were automatically
    captured at the time each call was received and stored on the
    Twilio telecommunications platform. Twilio is a publicly traded
    company that independently logs every call. I have personally
    reviewed each recording and I confirm they accurately represent
    the calls as received at my number. I have not edited or altered
    any recording. I also have cryptographic hash signatures that
    prove the recordings have not been tampered with since capture."

    If the judge asks about the hash signatures, here's how to
    explain it in plain English:

    "Your Honor, a SHA-256 hash is like a digital fingerprint. When
    each recording was first captured, my system computed a unique
    fingerprint — a long string of letters and numbers — from the
    exact contents of the audio file. If anyone changed even one
    second of the recording, the fingerprint would be completely
    different. It's the same technology the federal government uses
    for securing classified documents. I've included the original
    fingerprints in my evidence so the court can verify the
    recordings haven't been altered."

WHAT IF SERVICE FAILS (UNCLAIMED MAIL):
    If your certified mail comes back unclaimed or undeliverable:

    1. DON'T PANIC — this is common with spammers who use mail
       drops or P.O. boxes.
    2. Go back to the clerk and explain: "My certified mail was
       returned unclaimed. What alternative service methods are
       available?"
    3. Options include:
       → Personal service via constable or process server (they
         can serve at the business address during business hours)
       → Service on the registered agent (look up the company in
         the Secretary of State business registry — every LLC and
         corporation MUST have a registered agent for service)
       → Service by publication as a last resort under
         La. C.C.P. Art. 1263 (the clerk will explain the process)
    4. KEEP the returned envelope — it's evidence of your diligent
       attempt to serve.

IF DEFENDANT FILES A MOTION TO DISMISS:
    Don't panic — this is a standard delay tactic. Common grounds
    and your responses:

    "Lack of standing" → "I am the residential telephone subscriber.
    My phone bill proves it. I registered on the DNC list. I received
    these calls. I have standing under 47 U.S.C. § 227(c)(5)."

    "Improper service" → "I served via [certified mail / constable]
    as required by La. R.S. 13:5204. Here is my proof of service."

    "Failure to state a claim" → "My petition alleges: (1) I am on
    the DNC registry, (2) defendant called me ${offender.callCount} times,
    (3) within a 12-month period, (4) without my consent. Those are
    the four elements of a § 227(c)(5) claim."

    "Wrong court / jurisdiction" → "Defendant called a Louisiana
    phone number. That's sufficient minimum contact under La. R.S.
    13:3201(a). See also Burger King v. Rudzewicz."

${offender.willful
  ? `TREBLE DAMAGES SCRIPT:
    Because you sent a demand letter and the defendant kept calling,
    you can request $1,500 per violation instead of $500. Here's
    your script:

    "Your Honor, I sent a written cease-and-desist letter to the
    defendant on ${formatDate(offender.demandLetterDate!)} via certified mail.
    Despite receiving this notice, the defendant continued to call
    my DNC-registered number. This demonstrates willful and knowing
    violation of the TCPA, entitling me to treble damages of $1,500
    per violation under 47 U.S.C. § 227(c)(5)(B). I have the demand
    letter and certified mail receipt as Exhibit [refer to your
    exhibit letter]."

`
  : `CONSIDER SENDING A DEMAND LETTER FIRST:
    If you send a demand letter before filing (SpamSlayer can
    generate one) and the defendant keeps calling AFTER receiving
    it, their violations become "willful" — tripling your damages
    from $500 to $1,500 per call. This can dramatically increase
    your recovery.

`}SETTLEMENT NEGOTIATION:
    The defendant (or their lawyer) may contact you to settle
    before court. Here's how to handle it:

    → You are NOT obligated to settle — it's your choice.
    → A reasonable settlement is typically 50-80% of your claimed
      damages. Don't accept less than 40% unless there are real
      weaknesses in your case.
    → If they offer to settle, get it in WRITING before you agree
      to anything.
    → Ask the clerk: "If I settle, how do I dismiss my case?"
      Usually it's a one-page "Voluntary Dismissal" form.
    → NEVER sign a settlement that includes a "confidentiality"
      or "non-disparagement" clause without understanding it.
    → If they lowball you, just say: "I'll see you in court."
      Most spammers settle once they realize you're serious.

PREPARING YOUR EXHIBITS:
    Before court day, make sure you have PHYSICAL copies of
    everything. Judges cannot click URLs or play files from
    your laptop without preparation:

    → Print all documents and exhibits on paper
    → Copy recordings to a USB drive (bring 2 copies — one for
      the judge, one for you)
    → Print the call log table from your exhibit list
    → Print your phone bill with the spam calls highlighted
    → Print the DNC registry verification screenshot
    → Bring your phone as a backup way to play recordings
    → Label everything clearly: "Exhibit A", "Exhibit B", etc.
    → Use tabs or colored stickers so you can find exhibits fast
    → Print the evidence integrity certificate (the page with
      the long code numbers — it proves recordings weren't tampered
      with; you probably won't need it but bring it just in case)

═══════════════════════════════════════════════════════════════════════

STEP 5: COLLECT YOUR MONEY
───────────────────────────

If you win (and you very likely will):

    a) The court issues a judgment in your favor.

    b) Appeals: Under La. R.S. 13:5211, parties waive the right
       to appeal from a small claims judgment. However, under
       La. R.S. 13:5206 either party can TRANSFER the case to
       the regular civil docket of the City Court within the
       time set by court rule (Lafayette: written notice within
       10 days plus a $75 advanced cost deposit) — doing so
       preserves appeal rights from the regular-docket judgment.
       Most spammers do not bother. If the defendant transfers,
       the case is re-tried on the regular civil docket (same
       evidence, same arguments). If YOU lose and want to
       preserve appeal rights, ask the clerk IMMEDIATELY about
       the transfer procedure and deadline — don't wait, the
       window is short.

    c) If they don't pay, you can:
       → Ask the clerk about filing a Motion for Execution of
         Judgment — the clerk will explain the simplified
         collection procedures available for small claims
       → Options may include wage garnishment, bank account
         seizure, or liens on property
       → The clerk handles most of the paperwork for you

═══════════════════════════════════════════════════════════════════════

KEY LEGAL REFERENCES (for your confidence)
──────────────────────────────────────────

    Federal:
    → 47 U.S.C. § 227(c)(5) — Private right of action, $500-$1,500
    → 47 U.S.C. § 227(b)(1)(B) — Robocall/ATDS prohibition
    → 47 C.F.R. § 64.1200(c) — DNC Registry regulations
    → 47 C.F.R. § 64.1200(c)(2) — Safe harbor (defendant's burden)
    → 47 C.F.R. § 64.1200(f)(12) — Telephone solicitation definition
    → 18 U.S.C. § 2511(2)(d) — Federal one-party recording consent
    → Mims v. Arrow Financial, 565 U.S. 368 (2012) — State court OK
    → Spokeo v. Robins, 578 U.S. 330 (2016) — Concrete injury
    → TransUnion v. Ramirez, 594 U.S. 413 (2021) — Standing
    → Facebook v. Duguid, 141 S. Ct. 1163 (2021) — ATDS definition
    → McLaughlin Chiropractic v. McKesson, 606 U.S. ___ (2025) —
       Hobbs Act does NOT bind district courts to FCC TCPA orders;
       courts may independently interpret "consent," "ATDS," and
       "prior express consent" without automatic FCC deference.
       (Practical effect: if a defendant cites an FCC order as
       binding, argue the court can reach its own conclusion.)
    → Stoops v. Wells Fargo, 197 F. Supp. 3d 782 (W.D. Pa. 2016) —
       Adverse on "professional plaintiff" standing; see
       "Litigation factory" defense response above to distinguish.
    → Insurance Marketing Coalition Ltd. v. FCC, 127 F.4th 303
       (11th Cir. 2025) — VACATED the FCC's 2023 "one-to-one
       consent" rule that would have required separate consent
       for each seller on a lead-generation form. After this
       decision, a defendant may try to argue that looser,
       "bundled" consent captured by a lead broker satisfies the
       TCPA. Response: (i) vacatur does not authorize calls to
       DNC-registered numbers under § 227(c); (ii) the defendant
       still bears the burden of producing actual signed,
       specific consent tied to Plaintiff's number; (iii) an
       opaque lead-broker trail does not overcome Plaintiff's
       DNC registration; (iv) written consent obtained by fraud
       or without disclosure of the specific caller is not valid
       "prior express written consent" under § 227(a)(10).

    Louisiana:
    → ${config.stateDncStatute} — State DNC protections
    → ${config.stateRecordingLaw} — Recording is legal
    → La. R.S. 13:3201(a) — Long-arm statute (personal jurisdiction)
    → ${config.smallClaimsStatute} — Small claims procedure
    → La. R.S. 13:5202 — Small claims subject-matter jurisdiction
    → La. R.S. 13:5204 — Service of small-claims citation
    → La. R.S. 13:5206 — Transfer to regular civil docket
    → La. R.S. 13:5211 — Waiver of appeal rights
    → La. C.C.P. Art. 4843 — City Court amount-in-dispute jurisdiction

═══════════════════════════════════════════════════════════════════════

STATUTE OF LIMITATIONS REMINDER
────────────────────────────────

IMPORTANT: The TCPA's statute of limitations is a federal question.
The dominant rule post-Mims v. Arrow Financial (2012) is the
4-year federal catch-all at 28 U.S.C. § 1658(a), which applies
to any federal cause of action created after December 1, 1990
and for which no other limitations period is specified — that
fits the TCPA's private right of action. A minority of older
decisions borrowed shorter state SOLs (as low as 1–2 years),
and Louisiana courts have not uniformly resolved the question.
FILE AS SOON AS POSSIBLE so no SOL theory can be used against
you.

Using the most generous 4-year deadline: your earliest call was
on ${formatDate(offender.firstCallDate)}. You must file before ${formatDate(
    (() => {
      const d = new Date(offender.firstCallDate + "T12:00:00Z");
      d.setUTCFullYear(d.getUTCFullYear() + 4);
      return d.toISOString().split("T")[0];
    })()
  )} under the 4-year standard. But under a 2-year standard, your
deadline would be ${formatDate(
    (() => {
      const d = new Date(offender.firstCallDate + "T12:00:00Z");
      d.setUTCFullYear(d.getUTCFullYear() + 2);
      return d.toISOString().split("T")[0];
    })()
  )}. Don't wait — file now.

═══════════════════════════════════════════════════════════════════════

TIPS FOR SUCCESS
────────────────

    DO:
    → Be calm, polite, and organized in court
    → Let the evidence speak — recordings are very powerful
    → Refer to the law by section number (judges appreciate this)
    → Bring extra copies of everything
    → Arrive early and observe how the court operates

    DON'T:
    → Don't get emotional or angry
    → Don't exaggerate the number of calls
    → Don't claim anything you can't prove
    → Don't worry if you're not a lawyer — small claims is designed
      for regular people to represent themselves
    → Don't forget to bring your DNC registry printout — this is
      the foundation of your entire case

═══════════════════════════════════════════════════════════════════════

QUESTIONS? NEED HELP?
─────────────────────

    → Court clerk: ${config.courtClerkPhone} (they're very helpful)
    → FCC complaints: https://consumercomplaints.fcc.gov
    → FTC DNC: https://www.donotcall.gov
    → TCPA full text: https://www.law.cornell.edu/uscode/text/47/227

    SpamSlayer built your case. Now go win it.

═══════════════════════════════════════════════════════════════════════`;
}

// ─────────────────────────────────────────────────────────────────────────────
//  PUBLIC API — Generate the complete filing package
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generate a complete small claims court filing package for an actionable case.
 *
 * @param normalizedNumber - The offender's normalized phone number (from caseBuilder)
 * @param configOverrides  - Optional overrides for filing config (user info, court, etc.)
 * @returns FilingPackage with all documents, or null if case isn't actionable
 */
export function generateFilingPackage(
  normalizedNumber: string,
  configOverrides?: Partial<FilingConfig>
): FilingPackage | null {
  const offender = getOffender(normalizedNumber);
  if (!offender || !offender.actionable) {
    console.log(
      `[LegalFiling] Cannot generate filing: case ${normalizedNumber} is not actionable`
    );
    return null;
  }

  // Validate offender data integrity before generating legal documents
  try {
    validateOffenderForFiling(offender);
  } catch (err) {
    console.error(`[LegalFiling] Offender validation failed for ${normalizedNumber}: ${err}`);
    return null;
  }

  const config = { ...loadFilingConfig(), ...(configOverrides ?? {}) };

  // Validate config — will throw if user hasn't filled in their info
  validateFilingConfig(config);

  // PT2 (AUDIT_ROUND_16): refuse to generate a petition against the user's
  // own phone number. A bug in caseBuilder or a mistyped phone.json could
  // otherwise produce a filing that names the plaintiff as their own
  // defendant — Rule 11 / FRCP 11 sanctions exposure, and an instant
  // dismissal with the filer on the hook for fees. Catch it at the latest
  // possible stage so we have normalized numbers on both sides.
  try {
    const userNumKey = normalizePhone(config.userPhone);
    if (userNumKey && userNumKey === offender.normalizedNumber) {
      console.error(
        `[LegalFiling] REFUSED: offender ${normalizedNumber} matches ` +
        `filingConfig.userPhone (${config.userPhone}). Cannot sue your own ` +
        `telephone number.`
      );
      return null;
    }
  } catch {
    // normalizePhone throws on malformed input; validateFilingConfig
    // already rejected bad userPhone at the placeholder check, so a throw
    // here means an active bug — fail closed.
    console.error(
      `[LegalFiling] REFUSED: could not normalize filingConfig.userPhone ` +
      `for self-suit check; refusing to generate.`
    );
    return null;
  }

  // Freeze the generation timestamp FIRST — used by caseRef AND all 4 documents
  // to prevent midnight-boundary mismatches
  const generatedAt = new Date();

  const caseRef = generateCaseRef(offender, generatedAt);

  // Check for legal warnings (SOL, unknown defendant, etc.)
  const warnings: string[] = [];

  // H4 (AUDIT_ROUND_15): if the user has not told us whether their line
  // is residential, cellular, or mixed, the petition drops the primary-use
  // paragraph and pleads standing in neutral terms. Warn loudly so the
  // user fills this in before filing — the right DNC theory depends on it.
  if (config.lineType === "unspecified") {
    warnings.push(
      `LINE TYPE NOT CONFIRMED: filingConfig.lineType is "unspecified". The ` +
      `petition omits the sworn "residential primary use" paragraph and pleads ` +
      `standing in neutral terms. Before filing, open Settings → Legal and ` +
      `select one of: "residential" (normal landline/VoIP for personal use), ` +
      `"mixed" (primarily residential with incidental business use), or ` +
      `"cellular" (the phone is a mobile number). Choosing wrongly is ` +
      `dangerous — a sworn declaration that the line is residential when it ` +
      `is actually a business line undermines the petition and may expose ` +
      `you to a perjury challenge.`
    );
  }

  // Cross-check with case strength meter — warn if meter says not ready
  try {
    const strengthReport = evaluateCaseStrength(normalizedNumber);
    if (strengthReport && !strengthReport.readyToFile) {
      warnings.push(
        `CASE STRENGTH WARNING: The SpamSlayer case assessment rates this ` +
        `case as "${strengthReport.rating}" (score: ${strengthReport.score}/100) ` +
        `and recommends NOT filing yet. Reason: ${strengthReport.recommendation}. ` +
        `Proceeding to generate documents anyway, but review the warnings ` +
        `carefully before filing.`
      );
    }
  } catch {
    // Strength meter failure should not block filing generation
    console.warn(`[LegalFiling] Case strength check failed for ${normalizedNumber} — proceeding anyway`);
  }

  const solWarning = checkStatuteOfLimitations(offender);
  if (solWarning) {
    warnings.push(solWarning);
    console.warn(`[LegalFiling] ${solWarning}`);
    // HARD BLOCK: if SOL check returns a "BLOCKING WARNING" (all calls
    // older than 4 years — no viable claim under any theory), refuse to
    // generate the filing. The user should not be led to believe they
    // have a case to file when a court will dismiss on SOL grounds.
    if (solWarning.startsWith("BLOCKING WARNING")) {
      console.error(
        `[LegalFiling] Refusing to generate filing package for ${normalizedNumber}: ` +
        `all calls are beyond the 4-year SOL. Consult an attorney if you believe ` +
        `equitable tolling applies.`
      );
      return null;
    }
  }

  // Check for TCPA-exempt call types that would undermine the case
  const exemptTypes = offender.calls.map((c) => c.callType).filter(Boolean);
  if (exemptTypes.includes("debt_collection")) {
    warnings.push(
      `TCPA EXEMPTION WARNING — DEBT COLLECTION: One or more calls were identified ` +
      `as debt collection. Debt collection calls to landlines are generally NOT ` +
      `"telephone solicitations" under 47 C.F.R. § 64.1200(f)(12) and may be ` +
      `exempt from DNC protections. If the caller was collecting on a legitimate ` +
      `debt, the DNC claim (Count I) will likely fail. Consult an attorney before ` +
      `filing. If you have NO debt with this company, state that clearly in court.`
    );
  }
  if (exemptTypes.includes("political")) {
    warnings.push(
      `TCPA EXEMPTION WARNING — POLITICAL CALLS: One or more calls were identified ` +
      `as political in nature. Political calls are EXEMPT from DNC rules under ` +
      `47 C.F.R. § 64.1200(c)(2). You CANNOT sue a political campaign or party ` +
      `for calling a DNC-registered number. DO NOT file this petition if the ` +
      `calls were from a political organization.`
    );
  }
  if (exemptTypes.includes("survey")) {
    warnings.push(
      `TCPA EXEMPTION WARNING — SURVEY CALLS: One or more calls were identified ` +
      `as surveys or market research. Pure survey calls that do not attempt to ` +
      `sell anything are NOT "telephone solicitations" under 47 C.F.R. ` +
      `§ 64.1200(f)(12). If the calls had NO sales component, the DNC claim ` +
      `may fail. Review the recordings carefully — if there was ANY sales pitch ` +
      `during the call, it qualifies as a solicitation regardless of how it started.`
    );
  }

  // CRITICAL: Warn if defendant is unidentified
  if (!offender.companyName) {
    const unknownDefendantWarning =
      `CRITICAL — UNKNOWN DEFENDANT: SpamSlayer has not yet identified the ` +
      `company name behind ${offender.normalizedNumber}. Courts cannot enter ` +
      `judgment against a phone number — you MUST identify the defendant by ` +
      `legal name before filing. Steps to identify: (1) Search the phone ` +
      `number on the FCC complaint database, TrueCaller, or Whitepages; ` +
      `(2) Search the Louisiana Secretary of State business registry at ` +
      `https://www.sos.la.gov/BusinessServices; (3) Call the number back ` +
      `from a different line and ask for their company name; (4) Wait for ` +
      `another call — SpamSlayer will keep trying to extract the name. ` +
      `DO NOT file this petition until you have replaced "Unknown Entity" ` +
      `with the defendant's actual business name.`;
    warnings.push(unknownDefendantWarning);
    console.warn(`[LegalFiling] ${unknownDefendantWarning}`);
  }

  // EVIDENCE: Check if recordings have been cryptographically signed
  try {
    const sigs = loadSignaturesForNumber(offender.normalizedNumber);
    const recordedCallCount = offender.calls.filter((c) => c.recordingUrl).length;
    if (recordedCallCount > 0 && sigs.length === 0) {
      warnings.push(
        `UNSIGNED RECORDINGS: You have ${recordedCallCount} recording(s) but none ` +
        `have been cryptographically signed. The Evidence Integrity Certificate ` +
        `will show "0 signed calls" which weakens the tamper-proof claim. This ` +
        `may happen if recordings were captured before the signing feature was ` +
        `enabled. The recordings are still valid evidence, but the hash-based ` +
        `integrity verification will not be available.`
      );
    } else if (recordedCallCount > 0 && sigs.length < recordedCallCount) {
      warnings.push(
        `PARTIALLY SIGNED RECORDINGS: Only ${sigs.length} of ${recordedCallCount} ` +
        `recording(s) have been cryptographically signed. The Evidence Integrity ` +
        `Certificate will only cover signed recordings.`
      );
    }
  } catch {
    // Signature check failure should not block filing generation
  }

  // EVIDENCE: Warn if no recordings available
  const hasAnyRecordings = offender.calls.some((c) => c.recordingUrl);
  if (!hasAnyRecordings) {
    warnings.push(
      `NO RECORDINGS AVAILABLE: None of your calls from this number have ` +
      `recordings attached. Your case relies entirely on call metadata ` +
      `(dates, times, originating number), carrier CDRs, and Twilio logs. ` +
      `Recordings are the strongest evidence in TCPA cases — without them, ` +
      `the defendant may argue the calls weren't solicitations. Your case ` +
      `is still viable but significantly weaker. Try to obtain your carrier ` +
      `Call Detail Records to compensate.`
    );
  }

  // CRITICAL: Warn about spoofed caller IDs — suing wrong person is a disaster
  warnings.push(
    `VERIFY DEFENDANT IDENTITY — SPOOFED NUMBERS: Most spam calls use ` +
    `spoofed caller IDs. The phone number ${offender.normalizedNumber} may ` +
    `NOT belong to the actual caller. Before filing, verify the defendant's ` +
    `identity through multiple sources: (1) Listen to the recordings — did ` +
    `the caller identify a company name? (2) Search the number on TrueCaller, ` +
    `Whitepages, or the FCC complaint database. (3) Check if the number is a ` +
    `VoIP/disposable number (services like FreeCarrierLookup.com can tell you). ` +
    `If the number appears to be spoofed or disposable, you may be suing the ` +
    `wrong entity. DO NOT file until you can connect the phone number to an ` +
    `actual business entity.`
  );

  // PRACTICAL: Warn about consent traps (buried TOS agreements)
  warnings.push(
    `CHECK FOR BURIED CONSENT: Before filing, make sure you never gave consent ` +
    `to receive calls from this company — even indirectly. Data brokers sell ` +
    `"lead lists" with phone numbers attached to Terms of Service agreements ` +
    `you may have clicked years ago on unrelated websites. If the defendant ` +
    `produces a consent form or TOS agreement with your name on it, your case ` +
    `collapses. Search your email for any correspondence from the defendant's ` +
    `company name. If you find ANYTHING, consult an attorney before filing.`
  );

  // AUDIT_ROUND_18: generate defendant-research report + collectability score.
  // Replaces the old generic COLLECTABILITY CHECK warning with number-specific
  // heuristics and a prefilled manual-research checklist. The user reads
  // 05-defendant-research.txt BEFORE signing the petition verification.
  //
  // We build the warning message before generating the petition so the
  // filing guide (which is given `warnings` by reference below) includes the
  // collectability flag in its up-front summary.
  // AUDIT_ROUND_19: marshal cached enrichment from the offender profile
  // into the EnrichmentResult shape defendantResearch expects. Lookups are
  // populated asynchronously by /api/cases/log when isNewlyActionable, so
  // they're usually fresh by the time a filing is generated. Missing fields
  // gracefully no-op (defendantResearch falls back to offline heuristics).
  const enrichment: Parameters<typeof generateDefendantResearchReport>[1]["enrichment"] = {};
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
    } else if (e.status === "error") {
      enrichment.entity = { status: "error", errorMessage: e.errorMessage };
    } else {
      enrichment.entity = { status: "skipped", reason: "Cached lookup status: skipped" };
    }
  }

  const research = generateDefendantResearchReport(
    offender,
    {
      courtState: config.courtState,
      courtStateLong: stateNameLong(config.courtState),
      courtName: config.courtName,
      userPhone: config.userPhone,
      enrichment: Object.keys(enrichment).length > 0 ? enrichment : undefined,
    },
    caseRef,
    generatedAt
  );

  if (research.flagAsUncollectable) {
    // Unshift so this appears FIRST in the filing-guide warning summary —
    // if the defendant is uncollectable, the user should see it before any
    // lower-priority advice about spoofing or buried consent.
    warnings.unshift(
      `COLLECTABILITY — LOW SCORE (${research.collectability.score}/100): ` +
      `SpamSlayer's automated heuristics flag this defendant as likely ` +
      `UNCOLLECTABLE based on number prefix, caller-identification capture, ` +
      `and call-pattern persistence. A judgment you cannot collect costs ` +
      `filing fees and time for nothing. BEFORE filing, open the companion ` +
      `document "defendant_research.txt" in this package, complete every ` +
      `step of the MANUAL RESEARCH CHECKLIST (Secretary of State lookup, ` +
      `FCC complaint database, carrier traceback, litigation history, asset ` +
      `check), and read the ALTERNATIVES section. If you cannot identify a ` +
      `real, reachable US entity with assets, the right play is usually to ` +
      `sue the seller up the chain (TCPA seller liability, FCC 2013 DISH ` +
      `Network ruling), file FCC/FTC/state-AG complaints in parallel, or ` +
      `refer the case to a TCPA class-action firm — not to file in small ` +
      `claims against a spoofed number.`
    );
  } else {
    // Medium/high score: point the user at the research document without
    // sounding an alarm. Still required reading before verification.
    warnings.push(
      `COLLECTABILITY — ${research.collectability.band} (${research.collectability.score}/100): ` +
      `Before filing, read the companion document "defendant_research.txt" ` +
      `in this package. It contains a prefilled MANUAL RESEARCH CHECKLIST ` +
      `(Secretary of State lookup, FCC complaint database, carrier ` +
      `traceback, litigation history, asset check) that you must complete ` +
      `to confirm the defendant is reachable and has assets before signing ` +
      `the petition's sworn verification. Even with a ${research.collectability.band.toLowerCase()} ` +
      `preliminary score, the heuristics do NOT substitute for the manual ` +
      `steps — a filing against a dissolved entity or spoofed caller ID is ` +
      `a waste of the filing fee.`
    );
  }

  // R20: Generate lawful-pressure complaint bundle. This never throws —
  // complaintBundle.ts skips individual drafts whose threshold condition
  // is not met and returns them in `skipped[]`. Worst case: an empty
  // drafts[] array, which is fine; the filing still proceeds.
  let complaintBundle: ComplaintBundle;
  try {
    complaintBundle = generateComplaintBundle(offender, config);
  } catch (err) {
    console.error(
      `[LegalFiling] complaintBundle generation failed for ${caseRef}: ${err}. ` +
      `Petition will still be generated; user just won't get the agency drafts.`
    );
    complaintBundle = {
      drafts: [],
      readme: `Complaint bundle generation failed: ${err instanceof Error ? err.message : String(err)}`,
      skipped: [],
    };
  }

  // AUDIT_ROUND_19: append Sonar deep-research summary to defendantResearch.txt
  // when available. The defendantResearch module itself is offline-only and
  // doesn't render the Sonar prose; we splice it in at the orchestration
  // layer so the user reads it as part of the same checklist file.
  const sonar = offender.defendantWebResearch;
  let researchText = research.text;
  if (sonar?.status === "match" && sonar.summary) {
    const sonarSection = [
      "",
      "═══════════════════════════════════════════════════════════════════════",
      "  WEB RESEARCH SUMMARY  (auto-generated; verify before relying)",
      "═══════════════════════════════════════════════════════════════════════",
      "",
      `  Source:    Perplexity Sonar (${sonar.model ?? "sonar"})`,
      `  Looked up: ${sonar.lookedUpAt}`,
      "",
      "  This is an auto-synthesized summary from public web sources. Treat it",
      "  as a research starting point — every factual claim must be verified",
      "  against primary sources before you cite it in a sworn pleading.",
      "",
      "──────────────────────────────────────────────────────────────────────",
      "",
      sonar.summary,
      "",
    ];
    if (Array.isArray(sonar.citations) && sonar.citations.length > 0) {
      sonarSection.push("  Citations:");
      sonar.citations.slice(0, 20).forEach((c, i) => {
        sonarSection.push(`    [${i + 1}] ${c}`);
      });
      sonarSection.push("");
    }
    sonarSection.push("──────────────────────────────────────────────────────────────────────");
    sonarSection.push("");
    researchText = research.text + "\n" + sonarSection.join("\n");
  } else if (sonar?.status === "error") {
    researchText = research.text + `\n\n[Sonar deep-research lookup failed: ${sonar.errorMessage}]\n`;
  }

  // AUDIT_ROUND_21: prepend the GO/WAIT/DON'T-FILE verdict to the filing
  // guide so the user sees the system's recommendation FIRST when they
  // open the printed packet — before they spend $75 at the courthouse.
  const { decideFiling, renderDecisionForFilingGuide } = require("./filingDecision") as typeof import("./filingDecision");
  const decision = decideFiling(offender);
  const verdictHeader = renderDecisionForFilingGuide(decision);

  const pkg: FilingPackage = {
    petition: generatePetition(offender, config, caseRef, generatedAt),
    exhibitList: generateExhibitList(offender, config, caseRef, generatedAt),
    certificateOfService: generateCertificateOfService(offender, config, caseRef, generatedAt),
    filingGuide: verdictHeader + generateFilingGuide(offender, config, caseRef, warnings, generatedAt),
    defendantResearch: researchText,
    collectabilityScore: research.collectability.score,
    collectabilityBand: research.collectability.band,
    complaintBundle,
    caseNumber: caseRef,
    generatedDate: generatedAt.toISOString(),
    offenderNumber: normalizedNumber,
    damagesRequested: offender.damagesEstimate,
    warnings,
  };

  // AUDIT_ROUND_21: if the decision verdict is DON'T FILE, raise it as a
  // blocking warning so it shows up alongside the citation gate in the
  // user's view. The save-time gate in generateAndSaveFilingPackage uses
  // a separate FilingDecisionError to actually refuse the save.
  if (decision.verdict === "DONT_FILE") {
    warnings.unshift(
      `🛑 FILING DECISION: DON'T FILE — ${decision.reasoning[0] ?? "see filing guide header"}. ` +
      `Generating this packet against the system's recommendation requires explicit ` +
      `override at save time. Read the filing guide header for the full reasoning.`
    );
  } else if (decision.verdict === "WAIT") {
    warnings.unshift(
      `⏸ FILING DECISION: WAIT — ${decision.reasoning[0] ?? "see filing guide header"}. ` +
      `Recommended actions are listed in the filing guide header.`
    );
  }

  // ── Layer 1c (preview side): run the citation audit over the built pkg
  // and inject the results as warnings. This does NOT throw — the save path
  // (generateAndSaveFilingPackage) is responsible for translating blocking
  // issues into a hard refusal. Doing the injection here means the preview
  // endpoint and the printed filing guide both surface the same warnings
  // the user would hit at save time, so there are no nasty surprises.
  {
    const preCount = warnings.length;
    const gate = verifyFilingPackageCitations(pkg);
    // Blocking messages come first: if the save path will refuse, the user
    // deserves to see why in the preview too.
    for (const m of gate.blockingMessages) {
      warnings.unshift(`CITATION BLOCKING ISSUE — filing cannot be saved until fixed: ${m}`);
    }
    for (const w of gate.softWarningMessages) {
      warnings.unshift(w);
    }
    // If the warnings list changed, regenerate the filing guide so the
    // printed version reflects the new top-of-list warnings. The filing
    // guide embeds warnings by value at render time; without this
    // regeneration the printed guide would lag the JSON warnings array.
    if (warnings.length !== preCount) {
      pkg.filingGuide = generateFilingGuide(offender, config, caseRef, warnings, generatedAt);
    }
  }

  // Redact PII from logs — only log case ref and non-sensitive summary
  console.log(
    `[LegalFiling] Generated filing package ${caseRef} — ` +
    `${offender.callCount} calls, $${offender.damagesEstimate.toLocaleString()} in damages` +
    `${warnings.length > 0 ? ` (${warnings.length} warning(s))` : ""}`
  );

  return pkg;
}

// H1/H2 (AUDIT_ROUND_15): in-process mutex set. Rejects concurrent save
// requests for the same offender number so two simultaneous POSTs can't
// (a) generate two case numbers for the same offender, (b) race the
// markOffenderFiled flag, or (c) interleave temp-file writes in the same
// directory. A full-blown file lock would also defend against multiple
// processes, but SpamSlayer is a single-server self-hosted tool — one
// mutex per normalizedNumber is the right scope for now.
const INFLIGHT_SAVES = new Set<string>();

// ── Layer 1c: citation verification gate ────────────────────────────────
//
// Before any filing-package document hits the disk, every citation inside
// it runs through the verifier. Two outcomes matter:
//
//   HARD BLOCK — the filing save throws and nothing is written:
//     - any "conflict" (citation matched the registry but context says
//       something else — e.g. citing (b)(1)(A)(iii) alongside "residential")
//     - any "not-in-registry" hit (a citation string we've never seen —
//       this is the exact shape a hallucination would take)
//     - any "unparseable-citation" hit (extraction thinks it's a citation
//       but the parser can't normalize it — either an extraction bug or a
//       malformed citation; either way, the filing should not go out until
//       a human looks)
//
//   SOFT WARN — the filing save proceeds but a warning is appended to
//     pkg.warnings so the user sees it BEFORE signing:
//     - "registry-entry-not-human-verified" (the citation is in the
//       registry but no human has personally confirmed it against the
//       primary source yet).
//
// Rationale for the soft/hard split: 140 of the 140 citations currently
// emitted are registry-hits without a human stamp. Hard-blocking on those
// would make every filing fail until the full corpus is reviewed. The
// standard Marcus set — "no hallucinations possible" — is about *never
// inventing a citation* and *catching real-world mismatches*, not about
// refusing to ship until every known citation is double-stamped. The
// human-stamp backlog is tracked separately; the filing gate's job is to
// stop brand-new fabrications and live miscitation conflicts from
// reaching a sworn filing.

interface FilingGateResult {
  /** False → the save must abort. True → save may proceed. */
  passed: boolean;
  report: AuditReport;
  /** Blocking messages in plain English — surfaced to the user on failure. */
  blockingMessages: string[];
  /** Non-blocking warnings — appended to pkg.warnings so the user sees them. */
  softWarningMessages: string[];
}

/**
 * Collect every citation-bearing text field from a generated FilingPackage
 * and run the audit scanner over each. Returns a pass/fail plus the plain-
 * English messages to bubble up.
 *
 * This is a *pure* function — it reads pkg.* fields and does no I/O beyond
 * what auditTextBlobs does in memory. Safe to call before the disk writes
 * begin (which is where we call it).
 */
function verifyFilingPackageCitations(pkg: FilingPackage): FilingGateResult {
  const blobs: Array<{ file: string; text: string }> = [
    { file: `${pkg.caseNumber}_petition.txt`,                 text: pkg.petition },
    { file: `${pkg.caseNumber}_exhibits.txt`,                 text: pkg.exhibitList },
    { file: `${pkg.caseNumber}_certificate_of_service.txt`,   text: pkg.certificateOfService },
    { file: `${pkg.caseNumber}_filing_guide.txt`,             text: pkg.filingGuide },
    { file: `${pkg.caseNumber}_defendant_research.txt`,       text: pkg.defendantResearch },
  ];
  // Complaint bundle drafts — each one is a separate agency-facing document
  // and each one can contain its own citations. The README is informational
  // but may reference statutes too.
  if (pkg.complaintBundle?.readme) {
    blobs.push({ file: `complaints/README.txt`, text: pkg.complaintBundle.readme });
  }
  for (const draft of pkg.complaintBundle?.drafts ?? []) {
    const safeSlug = String(draft.slug || "draft").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 40);
    blobs.push({
      file: `complaints/${String(draft.priority).padStart(2, "0")}_${safeSlug}.txt`,
      text: draft.body,
    });
  }

  const report = auditTextBlobs(blobs);

  const blocking: string[] = [];
  const soft: string[] = [];
  let unregisteredCaseCount = 0;

  // Hard-block reasons
  for (const c of report.citations) {
    if (c.result.status === "conflict") {
      blocking.push(
        `Citation conflict in ${c.file} (line ${c.line}): "${c.citation}" — ` +
        c.result.detail,
      );
      continue;
    }
    if (c.result.status === "unverified") {
      if (c.result.reason === "not-in-registry") {
        // Policy split by citation kind:
        //   - federal-statute / federal-regulation / federal-public-law /
        //     state-statute / state-rule: hard-block. These are closed sets
        //     enumerated in statuteRegistry.ts; a not-in-registry hit on
        //     one of these is the shape a fabricated citation takes
        //     (a made-up title/section pair under some U.S.C. title we
        //     don't use). Refuse to emit.
        //   - federal-case: soft-warn. Case law is inherently open-ended
        //     (millions of opinions); enumerating every case a user might
        //     plausibly cite is not viable. The reporter+volume+page+year
        //     shape of a case citation is also more identifiable to a human
        //     reader than a fabricated subsection number, so the soft-warn
        //     "have a paralegal verify this case" is meaningful guidance
        //     rather than noise. Hard-block on every unregistered case
        //     would brick filings that cite real precedents like Mims v.
        //     Arrow or Spokeo v. Robins, which is worse for a senior user
        //     than the soft-warn path.
        if (c.kind === "federal-case") {
          unregisteredCaseCount++;
          continue; // handled by the aggregate soft warning below
        }
        blocking.push(
          `Unknown citation in ${c.file} (line ${c.line}): "${c.citation}" — ` +
          `this citation is not in the statute registry. SpamSlayer refuses ` +
          `to emit a citation it has not been taught. Add it to ` +
          `statuteRegistry.ts (with primary-source URL) before filing.`,
        );
      } else if (c.result.reason === "unparseable-citation") {
        blocking.push(
          `Unparseable citation in ${c.file} (line ${c.line}): "${c.citation}" — ` +
          `the verifier could not normalize this string. Fix the citation ` +
          `text or the extraction regex before filing.`,
        );
      } else if (c.result.reason === "quote-does-not-match-verified-text") {
        blocking.push(
          `Quote mismatch in ${c.file} (line ${c.line}) for ${c.citation}: ` +
          c.result.detail,
        );
      }
      // Else falls through to soft-warn bucket below.
    }
  }

  // Aggregate soft-warn for unregistered case citations. One message, not
  // one per citation, so the filing's warnings list stays readable.
  if (unregisteredCaseCount > 0) {
    soft.push(
      `Case-law review required: ${unregisteredCaseCount} case citation(s) in ` +
      `this filing are not in SpamSlayer's registry of known cases. The ` +
      `citations may be real — but because the project has not personally ` +
      `verified them against the reporter, you must treat them as unverified. ` +
      `Before signing this filing under oath: open the primary reporter for ` +
      `each case (Supreme Court Reporter, Federal Reporter, Federal ` +
      `Supplement) and confirm the cite, volume, page, and year exactly. ` +
      `A fabricated case citation in a sworn filing is a sanctionable ` +
      `offense (see Mata v. Avianca, 678 F. Supp. 3d 443 (S.D.N.Y. 2023)).`,
    );
  }

  // Soft-warn (single aggregate warning — surfacing 140 line-items would
  // drown the real warnings in pkg.warnings).
  if (report.byStatus.unverified > 0) {
    const unstamped = report.citations.filter(
      (c) => c.result.status === "unverified" &&
             c.result.reason === "registry-entry-not-human-verified",
    );
    if (unstamped.length > 0) {
      soft.push(
        `Citation review pending: ${unstamped.length} citation(s) in your ` +
        `filing are known to SpamSlayer but have not yet been personally ` +
        `verified against the government source by a human reviewer. ` +
        `This does not mean the citations are wrong — it means no one on ` +
        `this project has personally confirmed them in writing yet. If this ` +
        `filing will be sworn under oath, have a paralegal or lawyer ` +
        `double-check each citation against eCFR / uscode.house.gov before ` +
        `you sign. See CITATION_AUDIT_REPORT.txt for the full list.`,
      );
    }
  }

  return {
    passed: blocking.length === 0,
    report,
    blockingMessages: blocking,
    softWarningMessages: soft,
  };
}

/**
 * Error thrown when the citation gate refuses to save a filing package.
 * Kept as its own class so the API layer can return a 422 with the full
 * blocking-message list rather than a 500 + generic error.
 */
export class CitationGateError extends Error {
  readonly blockingMessages: string[];
  readonly report: AuditReport;
  constructor(blockingMessages: string[], report: AuditReport) {
    super(
      `[LegalFiling] Citation gate refused to save filing. ` +
      `${blockingMessages.length} blocking issue(s):\n` +
      blockingMessages.map((m) => "  • " + m).join("\n"),
    );
    this.name = "CitationGateError";
    this.blockingMessages = blockingMessages;
    this.report = report;
  }
}

/**
 * AUDIT_ROUND_21: error thrown when generateAndSaveFilingPackage refuses
 * because the GO/WAIT/DON'T-FILE decision came back as DON'T FILE. The
 * error includes the full decision so the API layer can show the user
 * exactly why and offer an explicit override path.
 *
 * Override: pass `overrideDecision: true` to generateAndSaveFilingPackage
 * to bypass this gate. The override is logged loudly so it's auditable.
 */
export class FilingDecisionError extends Error {
  readonly decision: import("./filingDecision").FilingDecision;
  constructor(decision: import("./filingDecision").FilingDecision) {
    super(
      `[LegalFiling] Save refused: filing-decision verdict is "${decision.verdict}" ` +
      `(confidence ${decision.confidence}%). Expected return $${decision.expectedValueUsd} ` +
      `vs costs $${decision.costEstimateUsd} (net $${decision.expectedValueUsd - decision.costEstimateUsd}). ` +
      `To file anyway, pass overrideDecision: true.`,
    );
    this.name = "FilingDecisionError";
    this.decision = decision;
  }
}

/**
 * Generate filing package and save all documents to disk as text files.
 * Returns the directory path where files were saved.
 *
 * Security: outputDir must be under the project's filings/ directory.
 *
 * Throws if a concurrent save is already in progress for the same number.
 *
 * AUDIT_ROUND_21: refuses to save if the filing-decision verdict is
 * "DONT_FILE" unless `overrideDecision: true` is passed.
 */
export function generateAndSaveFilingPackage(
  normalizedNumber: string,
  outputDir?: string,
  configOverrides?: Partial<FilingConfig>,
  options?: { overrideDecision?: boolean }
): { dir: string; files: string[] } | null {
  if (INFLIGHT_SAVES.has(normalizedNumber)) {
    throw new Error(
      `[LegalFiling] A filing save is already in progress for ${normalizedNumber}. ` +
      `Refusing to start a second concurrent save — this would risk duplicate ` +
      `case numbers or an inconsistent "filed" flag. Wait for the first save ` +
      `to finish and retry.`
    );
  }
  INFLIGHT_SAVES.add(normalizedNumber);
  try {
  // ── AUDIT_ROUND_21 GATE: filing decision check ──────────────────────
  // Run the decision before the expensive package generation so a refusal
  // doesn't waste citation-audit + research work.
  {
    const offenderForDecision = getOffender(normalizedNumber);
    if (offenderForDecision?.actionable) {
      const { decideFiling } = require("./filingDecision") as typeof import("./filingDecision");
      const decision = decideFiling(offenderForDecision);
      if (decision.verdict === "DONT_FILE" && !options?.overrideDecision) {
        console.warn(`[LegalFiling] Refusing to save ${normalizedNumber}: decision verdict is DONT_FILE`);
        throw new FilingDecisionError(decision);
      }
      if (decision.verdict === "DONT_FILE" && options?.overrideDecision) {
        console.warn(
          `[LegalFiling] OVERRIDE: saving ${normalizedNumber} despite DON'T_FILE verdict. ` +
          `Reasoning: ${decision.reasoning[0] ?? "(none)"}`
        );
      }
    }
  }

  const pkg = generateFilingPackage(normalizedNumber, configOverrides);
  if (!pkg) return null;

  // ── Layer 1c (save side): hard-block the save if the citation audit
  // finds any conflicts or not-in-registry (hallucination-shaped) hits.
  // Soft warnings were already merged into pkg.warnings by the package
  // builder above — we only re-run the audit here to decide throw vs.
  // proceed. Running before any disk write so a failing gate never leaves
  // a half-written filing package on disk.
  {
    const gate = verifyFilingPackageCitations(pkg);
    if (!gate.passed) {
      console.error(
        `[LegalFiling] Citation gate BLOCKED save for ${pkg.caseNumber}: ` +
        `${gate.blockingMessages.length} blocking issue(s).`,
      );
      throw new CitationGateError(gate.blockingMessages, gate.report);
    }
  }

  // M3 (AUDIT_ROUND_15): anchor filings/ to the source tree via __dirname,
  // not the current working directory. If the server is ever launched from
  // a different cwd (systemd, nohup from $HOME, docker), we do NOT want
  // filing packages to land in a surprise location or fail silently.
  // __dirname in compiled output resolves to backend/dist/services, so go
  // up two levels to reach backend/ and then into filings/.
  const baseDir = path.resolve(__dirname, "..", "..", "filings");
  let dir: string;

  if (outputDir) {
    // M4 (AUDIT_ROUND_15): prevent path traversal BEFORE creating any
    // directory. Prior order: mkdirSync then check — which would silently
    // create attacker-controlled directories on disk.
    const resolvedDir = path.resolve(outputDir);
    // Use path.relative + startsWith on a trailing-separator base to avoid
    // "filings-evil" false positives matching the "filings" prefix.
    const baseWithSep = baseDir.endsWith(path.sep) ? baseDir : baseDir + path.sep;
    if (resolvedDir !== baseDir && !resolvedDir.startsWith(baseWithSep)) {
      throw new Error(
        `[LegalFiling] Security: output directory must be under ${baseDir}, ` +
        `got ${resolvedDir}`
      );
    }
    dir = resolvedDir;
  } else {
    dir = path.join(baseDir, pkg.caseNumber);
  }

  // Ensure base exists first (idempotent), validated above.
  fs.mkdirSync(baseDir, { recursive: true, mode: 0o700 });
  // Then the case dir — now guaranteed to be under baseDir.
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  // Resolve symlinks to prevent path traversal attacks
  const realDir = fs.realpathSync(dir);
  const realBase = fs.realpathSync(baseDir);
  if (!realDir.startsWith(realBase)) {
    throw new Error(
      `[LegalFiling] Security: resolved directory ${realDir} is outside ` +
      `base ${realBase} (possible symlink attack)`
    );
  }

  const files: string[] = [];

  // Atomic write: write to temp file, then rename (prevents half-written docs)
  const writeDoc = (filename: string, content: string) => {
    const filepath = path.join(realDir, filename);
    const tmpPath = filepath + ".tmp";
    try {
      fs.writeFileSync(tmpPath, content, { encoding: "utf-8", mode: 0o600 });
      fs.renameSync(tmpPath, filepath);
    } catch (err) {
      // Clean up temp file on failure
      try { fs.unlinkSync(tmpPath); } catch {}
      throw err;
    }
    files.push(filepath);
  };

  // R20: complaint-bundle drafts go in a complaints/ subdirectory so they
  // don't clutter the main filing folder. writeSubDoc performs the same
  // atomic-write + path-traversal checks as writeDoc.
  const writeSubDoc = (subdir: string, filename: string, content: string) => {
    // Defensive: reject subdir path separators to pin writes to one level deep.
    if (subdir.includes(path.sep) || subdir.includes("..") || subdir.includes("/") || subdir.includes("\\")) {
      throw new Error(`[LegalFiling] Security: invalid subdir "${subdir}"`);
    }
    // Same for filename — no traversal.
    if (filename.includes(path.sep) || filename.includes("..") || filename.includes("/") || filename.includes("\\")) {
      throw new Error(`[LegalFiling] Security: invalid subdoc filename "${filename}"`);
    }
    const subDir = path.join(realDir, subdir);
    fs.mkdirSync(subDir, { recursive: true, mode: 0o700 });
    // Re-resolve and re-verify after mkdir to defend against a mid-flight
    // symlink swap on the new directory.
    const realSubDir = fs.realpathSync(subDir);
    if (!realSubDir.startsWith(realDir)) {
      throw new Error(
        `[LegalFiling] Security: subdir ${realSubDir} escaped ${realDir} ` +
        `(possible symlink attack)`
      );
    }
    const filepath = path.join(realSubDir, filename);
    const tmpPath = filepath + ".tmp";
    try {
      fs.writeFileSync(tmpPath, content, { encoding: "utf-8", mode: 0o600 });
      fs.renameSync(tmpPath, filepath);
    } catch (err) {
      try { fs.unlinkSync(tmpPath); } catch {}
      throw err;
    }
    files.push(filepath);
  };

  // Wrap all writes so partial failures don't leave orphaned files
  try {
    writeDoc(`${pkg.caseNumber}_petition.txt`, pkg.petition);
    writeDoc(`${pkg.caseNumber}_exhibits.txt`, pkg.exhibitList);
    writeDoc(`${pkg.caseNumber}_certificate_of_service.txt`, pkg.certificateOfService);
    writeDoc(`${pkg.caseNumber}_filing_guide.txt`, pkg.filingGuide);
    // AUDIT_ROUND_18: defendant-research + collectability checklist. Written
    // AFTER the petition so if rollback fires on the petition write, we never
    // leak a research report for a case whose petition never landed.
    writeDoc(`${pkg.caseNumber}_defendant_research.txt`, pkg.defendantResearch);

    // AUDIT_ROUND_20: include the per-case evidence checklist + the case
    // stages roadmap as printable text files in the saved package. Both
    // are user-facing prep documents, not court exhibits — they live in
    // the same folder so the user has the whole "what to do next" stack
    // in one place.
    //
    // Re-fetch offender and merged config here since this scope is inside
    // generateAndSaveFilingPackage which doesn't have them as locals.
    try {
      const saveOffender = getOffender(normalizedNumber);
      const saveCfg = { ...loadFilingConfig(), ...(configOverrides ?? {}) };
      const { renderChecklistAsText, buildCaseStagesGuide } = require("./evidenceChecklist") as typeof import("./evidenceChecklist");
      if (saveOffender?.evidenceChecklist) {
        const checklistText = renderChecklistAsText(saveOffender.evidenceChecklist, saveOffender);
        writeDoc(`EVIDENCE_CHECKLIST.txt`, checklistText);
      }
      if (saveOffender) {
        const userCtx = {
          userName: saveCfg.userName, userPhone: saveCfg.userPhone,
          userAddress: saveCfg.userAddress, userEmail: saveCfg.userEmail,
          userState: saveCfg.userState, userStateLong: stateNameLong(saveCfg.userState),
          courtName: saveCfg.courtName,
        };
        const stagesText = buildCaseStagesGuide(saveOffender, userCtx);
        writeDoc(`CASE_STAGES_GUIDE.txt`, stagesText);

        // AUDIT_ROUND_22: pressure stack — every parallel-enforcement path
        // we can deploy against this defendant, even when the case is
        // uncollectable in court. Includes carrier abuse complaint,
        // class-action firm referral, USTelecom escalation, state PUC
        // complaint, robocall blacklist submissions, and seller-liability
        // identification.
        try {
          const { buildPressureStack, renderPressureStackAsText } =
            require("./pressureStack") as typeof import("./pressureStack");
          const stack = buildPressureStack(saveOffender, userCtx);
          const stackText = renderPressureStackAsText(stack, saveOffender);
          writeDoc(`PRESSURE_STACK.txt`, stackText);
          // Also write the class-action referral as its own copy-paste-ready
          // file so the user can email it directly to a TCPA firm.
          const classRefItem = stack.items.find((i) => i.id === "class-action-referral");
          if (classRefItem?.template) {
            writeDoc(`CLASS_ACTION_REFERRAL.txt`, classRefItem.template);
          }
        } catch (err) {
          console.warn(`[LegalFiling] Pressure stack write failed: ${(err as Error).message}`);
        }
      }
    } catch (err) {
      console.warn(`[LegalFiling] Failed to write checklist/stages files: ${(err as Error).message}`);
      // Non-fatal — petition still saves.
    }

    // R20: Write complaint bundle to complaints/ subfolder. One file per
    // draft + a README. Drafts that hit threshold-skip are omitted but
    // surfaced in the README so the user knows WHY they're missing.
    if (pkg.complaintBundle.readme) {
      writeSubDoc("complaints", "README.txt", pkg.complaintBundle.readme);
    }
    for (const draft of pkg.complaintBundle.drafts) {
      // slug is priority-stable and module-controlled; still sanitize.
      const safeSlug = draft.slug.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 40);
      const filename = `${String(draft.priority).padStart(2, "0")}_${safeSlug}.txt`;
      writeSubDoc("complaints", filename, draft.body);
    }

    // Also save a summary JSON for programmatic use (filenames only, no full paths)
    writeDoc(`${pkg.caseNumber}_summary.json`, JSON.stringify({
      caseNumber: pkg.caseNumber,
      generatedDate: pkg.generatedDate,
      offenderNumber: pkg.offenderNumber,
      damagesRequested: pkg.damagesRequested,
      collectabilityScore: pkg.collectabilityScore,
      collectabilityBand: pkg.collectabilityBand,
      warnings: pkg.warnings,
      complaintDrafts: pkg.complaintBundle.drafts.map((d) => ({
        slug: d.slug,
        label: d.label,
        submitUrl: d.submitUrl,
        priority: d.priority,
      })),
      complaintSkipped: pkg.complaintBundle.skipped,
      files: files.map((f) => path.basename(f)),
    }, null, 2));
  } catch (err) {
    // Rollback: remove all files written so far to prevent orphaned PII
    for (const f of files) {
      try { fs.unlinkSync(f); } catch {}
    }
    // Also remove the complaints/ subdir if we created it. rmdir only succeeds
    // on empty dirs, so the prior unlink loop must have cleared it first.
    try {
      const complaintsDir = path.join(realDir, "complaints");
      if (fs.existsSync(complaintsDir)) fs.rmdirSync(complaintsDir);
    } catch {}
    console.error(`[LegalFiling] Failed to write filing package, rolled back ${files.length} file(s)`);
    throw err;
  }

  console.log(`[LegalFiling] Saved filing package to ${dir}:`);
  files.forEach((f) => {
    try {
      const size = fs.statSync(f).size;
      console.log(`  → ${path.basename(f)} (${size} bytes)`);
    } catch {
      console.log(`  → ${path.basename(f)}`);
    }
  });

  // Freeze the offender profile — no more logCall mutations should roll into
  // this case after a filing package has been saved to disk. New calls will
  // be routed to a continuation profile by caseBuilder.logCall(). This
  // prevents the scenario where damagesEstimate silently changes after the
  // petition was generated.
  try {
    const marked = markOffenderFiled(normalizedNumber, pkg.caseNumber);
    if (marked) {
      console.log(
        `[LegalFiling] Offender ${normalizedNumber} marked as filed ` +
        `(caseRef=${pkg.caseNumber}). New calls will open a continuation profile.`
      );
    } else {
      console.warn(
        `[LegalFiling] Could not mark offender ${normalizedNumber} as filed — ` +
        `profile missing from case DB. Filing package was still saved.`
      );
    }
  } catch (err) {
    // Do NOT fail the filing save on a mark-as-filed error. The package is
    // already on disk and the user may need it regardless of DB state.
    console.error(
      `[LegalFiling] Failed to mark offender ${normalizedNumber} as filed: ${err}. ` +
      `Filing package is still available at ${dir}.`
    );
  }

  return { dir, files };
  } finally {
    INFLIGHT_SAVES.delete(normalizedNumber);
  }
}
