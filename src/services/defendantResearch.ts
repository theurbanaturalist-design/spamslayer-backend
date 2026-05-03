// ─────────────────────────────────────────────────────────────────────────────
//  defendantResearch.ts — Pre-filing defendant research + collectability
//
//  The existential question for any small-claims TCPA suit is not "is the law
//  on my side" — the law is. The question is "will I collect money from this
//  defendant if I win." This module produces a hybrid research report that
//  (1) runs STATIC automated heuristics against the offender's phone number,
//  captured caller names, transcripts, and call pattern; (2) generates a
//  prefilled manual-research checklist pointing the user at the right public
//  registries; (3) scores collectability on a 0–100 scale; and (4) when the
//  score is low, emits an ALTERNATIVES section so the user doesn't waste a
//  filing fee on an uncollectable judgment.
//
//  This module is DELIBERATELY STATIC at generation time. It does not make
//  network calls. Runtime network calls from a legal-filing pipeline are a
//  bad idea: they introduce flaky failure modes right before the user signs
//  a sworn document, they leak PII to third-party services, and they turn
//  offline reproduction of filings into a nightmare. Enrichment from paid
//  APIs (Twilio Lookup, OpenCNAM, PACER/CourtListener, FCC opendata) is
//  supported through the EnrichmentProvider interface — the caller can pass
//  pre-fetched enrichment results, but the default path is 100 % offline.
//
//  SCOPE NOTE: heuristics here are preliminary signals — they never substitute
//  for the manual verification checklist. The report is explicit about this.
//
//  AUDIT_ROUND_19: substantially hardened. New heuristics: Caribbean +1
//  high-fraud NPAs, neighbor-spoofing (NPA+NXX match to user phone), DNC-hour
//  call-time analysis, transcript scam-phrase detection, invalid-NANPA
//  format validation (N11, 0-prefix, 1-prefix), sequential subscriber
//  digits, companyName ↔ callerNames cross-reference, entity-suffix
//  stripping, full input sanitization. Plus an EnrichmentProvider hook for
//  future API integrations.
// ─────────────────────────────────────────────────────────────────────────────

import type { OffenderProfile } from "./caseBuilder";

// ══════════════════════════════════════════════════════════════════════════
//  TYPES
// ══════════════════════════════════════════════════════════════════════════

export interface CollectabilityScore {
  score: number;              // 0–100 (higher = better)
  band: "LOW" | "MEDIUM" | "HIGH";
  signals: Array<{
    label: string;            // human-readable signal name
    delta: number;            // positive or negative contribution to score
    note: string;             // one-line explanation
    category?: SignalCategory; // what kind of signal this is
  }>;
}

export type SignalCategory =
  | "number"
  | "identity"
  | "pattern"
  | "content"
  | "spoof"
  | "enrichment";

export interface DefendantResearchReport {
  /** Full rendered text for file output (05-defendant-research.txt). */
  text: string;
  /** Numeric collectability score and band (used by caller for warnings). */
  collectability: CollectabilityScore;
  /** True if the report flags this case as likely uncollectable. */
  flagAsUncollectable: boolean;
}

export interface ResearchConfig {
  /** USPS postal code of the user's state, e.g. "LA". Used to tailor SoS/AG links. */
  courtState: string;
  /** Full state name for readability, e.g. "Louisiana". */
  courtStateLong: string;
  /** The user's small-claims court name, for context. */
  courtName: string;
  /**
   * The user's own phone number (E.164 or close to it). Used ONLY for
   * neighbor-spoof detection: if the offender's NPA+NXX matches the user's,
   * the caller ID is near-certainly spoofed. Optional — if absent, the
   * neighbor-spoof heuristic is skipped.
   */
  userPhone?: string;
  /**
   * Optional pre-fetched enrichment from paid APIs. The caller is expected
   * to fetch these asynchronously and pass them in; the research module
   * never calls the network itself. Default: none.
   */
  enrichment?: EnrichmentResult;
}

/**
 * EnrichmentProvider: a caller-supplied interface for fetching extra data
 * from paid APIs. This module does NOT invoke enrichment — the caller is
 * responsible for network I/O, caching, error handling, and PII redaction.
 * Results are passed in via ResearchConfig.enrichment.
 *
 * Recommended providers (ranked by value vs. cost):
 *   1. Twilio Lookup API        — line-type + carrier ($0.005/lookup)
 *   2. FCC Consumer Complaint DB — public dataset, free (opendata.fcc.gov)
 *   3. OpenCorporates API       — entity lookup, free tier available
 *   4. CourtListener / RECAP    — federal litigation history, free for non-profits
 *   5. OpenCNAM                 — caller-name lookup, $0.004/lookup
 *
 * ADR: the module remains 100 % offline by default because a network call
 * right before a sworn filing is fragile (timeouts, upstream outages, third
 * parties changing their schema). Enrichment is additive, not load-bearing.
 */
export interface EnrichmentResult {
  /** Twilio-style line-type info, if available. */
  lineType?: {
    type: "landline" | "mobile" | "voip" | "unknown";
    carrier?: string;
    countryCode?: string;
  };
  /** Count of consumer complaints filed against this number, if known. */
  consumerComplaintCount?: number;
  /**
   * LEGACY coarse flag — kept for backwards compatibility with older
   * callers that only had a boolean. If `entity` is populated below, that
   * richer field wins and this flag is ignored. New callers should set
   * `entity` instead.
   */
  entityFoundInRegistry?: boolean;
  /**
   * Richer entity-registry lookup result (OpenCorporates / state SoS).
   * When populated, feeds the status + age signals. The lookup itself
   * lives in openCorporatesClient.ts. Callers orchestrate network I/O.
   *
   * Discriminator semantics:
   *   "match"     → feed status/age signals (possibly positive or negative)
   *   "no_match"  → SINGLE strong-negative collectability signal
   *                 (user explicitly chose penalize-on-no-match for v1)
   *   "skipped"   → NO signal. We didn't look, so we can't judge.
   *   "error"     → NO signal. Network / API problem is not the caller's
   *                 fault; penalizing on errors would be grossly unfair.
   */
  entity?: EntityEnrichment;
  /** Prior litigation count from CourtListener/PACER. */
  priorLitigationCount?: number;
  /** Free-text notes from the enrichment layer (rendered verbatim). */
  notes?: string[];
}

/**
 * Entity-registry lookup result, discriminated by `status`. Mirrors (but
 * intentionally does not import from) openCorporatesClient.ts so
 * defendantResearch can live in isolation for unit testing.
 *
 * The status values match EntityLookupResult's so callers can pass the
 * networked client's result through without conversion.
 */
export type EntityEnrichment =
  | EntityEnrichmentMatch
  | EntityEnrichmentNoMatch
  | EntityEnrichmentSkipped
  | EntityEnrichmentError;

export interface EntityEnrichmentMatch {
  status: "match";
  matchedName: string;
  companyNumber?: string;
  jurisdictionCode?: string;
  /** Active / inactive / dissolved / unknown — see openCorporatesClient. */
  normalizedStatus: "active" | "inactive" | "dissolved" | "unknown";
  rawStatus?: string | null;
  incorporationDate?: string | null;
  registeredAddress?: string | null;
  sourceUrl?: string;
  lookedUpAt?: string;
  /** "exact" / "high" / "low" — name-match strength. Low should reduce trust. */
  matchConfidence?: "exact" | "high" | "low";
}

export interface EntityEnrichmentNoMatch {
  status: "no_match";
  query?: string;
  jurisdictionCode?: string | null;
  lookedUpAt?: string;
}

export interface EntityEnrichmentSkipped {
  status: "skipped";
  reason?: string;
}

export interface EntityEnrichmentError {
  status: "error";
  errorMessage?: string;
  httpStatus?: number;
}

// ══════════════════════════════════════════════════════════════════════════
//  CONSTANTS / REFERENCE DATA
// ══════════════════════════════════════════════════════════════════════════

/**
 * +1 Country Code Caribbean / overseas-US-territory area codes. These LOOK
 * like US numbers (and dial through the NANPA) but are in a foreign
 * jurisdiction or US territory where small-claims process service is
 * impractical or impossible. Many are hot-spots for toll-call fraud and
 * "one-ring" scams.
 *
 * Source: ITU-T E.164, NANPA Country Code 1 territory map (2024-2025).
 * A signal, not proof — legitimate businesses do operate from some of these
 * territories (notably Puerto Rico 787/939) — but the COLLECTABILITY prior
 * for small-claims-court-in-your-state is strongly negative.
 */
const CARIBBEAN_AND_TERRITORY_NPAS = new Set<string>([
  "242", // Bahamas
  "246", // Barbados
  "264", // Anguilla
  "268", // Antigua and Barbuda
  "284", // British Virgin Islands
  "340", // U.S. Virgin Islands (US territory — reachable but small pool)
  "345", // Cayman Islands
  "441", // Bermuda
  "473", // Grenada
  "649", // Turks and Caicos
  "664", // Montserrat
  "670", // Northern Mariana Islands (US territory)
  "671", // Guam (US territory)
  "684", // American Samoa (US territory)
  "721", // Sint Maarten
  "758", // Saint Lucia
  "767", // Dominica
  "784", // Saint Vincent and the Grenadines
  "787", // Puerto Rico (US territory — has assets, leave as softer penalty)
  "809", // Dominican Republic
  "829", // Dominican Republic
  "849", // Dominican Republic
  "868", // Trinidad and Tobago
  "869", // Saint Kitts and Nevis
  "876", // Jamaica — famous "Jamaican lottery" scam origin
  "939", // Puerto Rico
]);

/**
 * US territory NPAs that technically fall under US federal process but are
 * impractical targets in a Louisiana (or any other state) small-claims
 * action — you'd need to sue locally. Treat as a softer penalty than pure
 * foreign NPAs.
 */
const US_TERRITORY_SOFT_NPAS = new Set<string>([
  "340", "670", "671", "684", "787", "939",
]);

/** Toll-free NPAs. */
const TOLL_FREE_NPAS = new Set<string>([
  "800", "833", "844", "855", "866", "877", "888",
]);

/** 5XX-series personal-communications (often VoIP/disposable). */
const FIVE_HUNDRED_SERIES = new Set<string>([
  "500", "521", "522", "523", "524", "525", "526", "527", "528", "529",
  "532", "533", "535", "538", "542", "543", "544", "545", "546", "547",
  "549", "552", "566", "577", "588",
]);

/** N11 service codes — never valid as NPAs in the NANPA. */
const N11_CODES = new Set<string>([
  "211", "311", "411", "511", "611", "711", "811", "911",
]);

/**
 * Scam pitch phrases. Each match is a negative signal. The list is intended
 * to be precise enough that a legitimate business call wouldn't trigger
 * multiple phrases. See tests for adversarial clean-transcript coverage.
 */
const SCAM_PHRASES: Array<{ re: RegExp; tag: string; delta: number }> = [
  { re: /\bpress\s+(1|one)\s+(to\s+lower|to\s+speak|for\s+a\s+specialist|to\s+be\s+connected)\b/i, tag: "press-1 robocall hook", delta: -6 },
  { re: /\bauto(?:motive)?\s+warranty\b.*\b(expir|ending|about\s+to|final)/i, tag: "auto-warranty pitch", delta: -6 },
  { re: /\b(your\s+)?(vehicle|car)(?:'s|\s+is)?\s+(?:factory\s+)?warranty\s+(?:is\s+)?(expir|ending|about\s+to)/i, tag: "vehicle-warranty pitch", delta: -6 },
  { re: /\b(this\s+is\s+)?your\s+(final|last)\s+notice\b/i, tag: "final-notice urgency scam", delta: -5 },
  { re: /\b(the\s+)?IRS\s+(is\s+)?(filing\s+suit|taking\s+legal\s+action|pursuing|about\s+to\s+file)/i, tag: "IRS impersonation", delta: -10 },
  { re: /\bsocial\s+security\s+number\s+(has\s+been\s+)?(suspended|compromised|flagged)/i, tag: "SSA impersonation", delta: -10 },
  { re: /\b(you\s+have\s+been\s+)?selected\s+for\s+(a|an)\s+(government\s+)?grant\b/i, tag: "government-grant scam", delta: -8 },
  { re: /\bcongratulat(ion)?s?\b.*\b(you('ve|\s+have)?\s+won|winner)\b/i, tag: "sweepstakes scam", delta: -8 },
  { re: /\bstudent\s+loan\s+(forgiveness|relief|debt\s+cancel)/i, tag: "student-loan-forgiveness scam", delta: -6 },
  { re: /\bmedicare\s+(?:card|benefits?|plan)\s+(?:update|renew|verify|activate)/i, tag: "Medicare card scam", delta: -6 },
  { re: /\blower(?:ing)?\s+your\s+(?:interest\s+)?rate\s+(?:on\s+)?(?:credit\s+card|debt)/i, tag: "credit-card rate scam", delta: -6 },
  { re: /\bsolar\s+(panel|energy)\s+(?:for\s+)?(?:your\s+)?home\b.*(?:free|no\s+cost|government)/i, tag: "solar 'free' pitch", delta: -4 },
  { re: /\bextended\s+(auto|vehicle|car)\s+(?:service|protection|warranty)\b/i, tag: "extended-warranty pitch", delta: -6 },
  { re: /\byour\s+account\s+(has\s+been\s+)?(suspend|hack|compromis|lock)/i, tag: "account-takeover impersonation", delta: -6 },
];

/**
 * Generic caller identifiers — names that do NOT identify a legal entity.
 * Matched AFTER normalization (entity-suffix stripped, lowercased, collapsed
 * whitespace). The list is deliberately conservative: "ABC Corp" is NOT
 * generic even after stripping "Corp", but "compliance dept" is.
 */
const GENERIC_CALLER_NAMES = new Set<string>([
  "mike", "sarah", "john", "jane", "bob", "david", "susan", "tom", "lisa",
  "mark", "chris", "mary", "maria", "joe",
  "auto warranty", "warranty department", "warranty dept", "warranty",
  "warranty services", "auto protection", "vehicle services",
  "customer service", "customer support", "compliance", "compliance department",
  "compliance dept", "sales", "sales department", "sales dept",
  "department", "dept", "agent", "representative", "your representative",
  "consumer affairs", "the office", "main office", "fulfillment",
  "billing", "billing department",
  "your lender", "lender", "your bank", "bank",
  "the team", "the team here", "headquarters", "corporate",
  "notifications", "automated messaging system", "autodialer", "voicemail",
]);

/** Entity suffixes stripped before generic detection. */
const ENTITY_SUFFIXES = [
  "limited liability company", "l l c", "l.l.c.", "l.l.c", "llc",
  "incorporated", "inc.", "inc",
  "corporation", "corp.", "corp",
  "company", "co.", "co",
  "limited", "ltd.", "ltd",
  "group", "holdings", "partners", "partnership", "lp", "lllp",
  "services", "svcs",
];

// ══════════════════════════════════════════════════════════════════════════
//  INPUT SANITIZATION (defensive — never trust OffenderProfile fields)
// ══════════════════════════════════════════════════════════════════════════

/** Coerce to string, strip dangerous chars, truncate to a reasonable max. */
function safeString(v: unknown, maxLen = 500): string {
  if (v === null || v === undefined) return "";
  let s = typeof v === "string" ? v : String(v);
  // Strip C0 controls (except tab/newline), zero-width codepoints, BOMs.
  s = s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
  s = s.replace(/[\u200B-\u200F\u2028-\u202F\u2060-\u206F\uFEFF]/g, "");
  if (s.length > maxLen) s = s.slice(0, maxLen);
  return s;
}

/**
 * Sanitize a user-originated string for display in the plain-text report.
 * Strips HTML-like metacharacters (<, >) and backticks so that even if the
 * report gets previewed in a rich-text or HTML context, we do not emit raw
 * markup. Caller names may legitimately contain & and quotes — those are
 * preserved. Use this wherever user-controlled text is echoed into the
 * rendered report body. For URLs, continue to use urlEncode() / encodeURIComponent.
 */
function safeDisplay(v: unknown, maxLen = 500): string {
  const s = safeString(v, maxLen);
  // Replace angle brackets with full-width lookalikes so the name is still
  // human-readable but cannot be misinterpreted as HTML. Backticks stripped.
  return s.replace(/</g, "(").replace(/>/g, ")").replace(/`/g, "'");
}

/** Digits-only extraction from a possibly messy phone string. */
function digitsOnly(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = typeof v === "string" ? v : String(v);
  return s.replace(/\D/g, "");
}

/**
 * Render a phone number safely for display in the rendered report. Strips
 * everything except the digits, then re-prefixes with "+". For US/NANPA
 * 10- or 11-digit input, renders "+1 (NPA) NXX-XXXX". Anything else is
 * rendered as "+<digits>" with no further formatting. If no digits remain,
 * returns "(no number on file)". This function guarantees that the
 * returned string contains ONLY digits, spaces, dashes, parentheses, and
 * a leading plus — it cannot leak injection characters of any kind.
 */
function safePhoneDisplay(v: unknown): string {
  const d = digitsOnly(v).slice(0, 20);
  if (!d) return "(no number on file)";
  if (d.length === 10) {
    return `+1 (${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
  }
  if (d.length === 11 && d.startsWith("1")) {
    const r = d.slice(1);
    return `+1 (${r.slice(0, 3)}) ${r.slice(3, 6)}-${r.slice(6)}`;
  }
  return `+${d}`;
}

/**
 * Extract the 10-digit US portion of a NANPA number. Returns "" if the
 * number is not a plain NANPA format (e.g., international +44..., short,
 * empty, or has more than 10 digits after optional +1).
 */
function extractNanpa10(raw: unknown): string {
  const d = digitsOnly(raw);
  if (d.length === 10) return d;
  if (d.length === 11 && d.startsWith("1")) return d.slice(1);
  return "";
}

// ══════════════════════════════════════════════════════════════════════════
//  INDIVIDUAL HEURISTICS
// ══════════════════════════════════════════════════════════════════════════

type Signal = { label: string; delta: number; note: string; category?: SignalCategory };

/**
 * Evaluate the originating phone number. Covers: format validity, Caribbean
 * +1 NPAs, US territories, toll-free, 500-series, 900-series, invalid-NANPA
 * (N11, 0/1-leading NPA), repeating digits, sequential digits, and the
 * 1212 demo pattern. Signals are SIGNAL, not proof.
 */
function evaluateNumberSignals(rawNumber: unknown): Signal[] {
  const signals: Signal[] = [];
  const raw = safeString(rawNumber, 30);
  const d = digitsOnly(raw);

  // --- Format validity -----------------------------------------------------
  if (d.length === 0) {
    signals.push({
      label: "Empty / missing phone number",
      delta: -20,
      note: "OffenderProfile.normalizedNumber is empty. No research is possible. Investigate how this profile got created without a number.",
      category: "number",
    });
    return signals;
  }
  const nanpa = extractNanpa10(raw);
  if (nanpa === "") {
    // Non-NANPA or malformed length.
    if (d.length > 11) {
      signals.push({
        label: "International / non-NANPA originating number",
        delta: -18,
        note:
          `Originating number has ${d.length} digits, indicating an international ` +
          "dialing format (+44, +91, +86, etc.) or a malformed CDR entry. " +
          "A foreign-originated call is not reachable by US small-claims " +
          "process service — pursue FCC traceback or sue the US seller instead.",
        category: "number",
      });
    } else {
      signals.push({
        label: "Non-standard number format",
        delta: -15,
        note:
          `Originating number has ${d.length} digits — not a standard 10-digit ` +
          "NANPA number. Either international, short-code, or malformed CDR data. " +
          "Verify the raw carrier record before relying on this number.",
        category: "number",
      });
    }
    return signals;
  }

  const npa = nanpa.slice(0, 3);
  const nxx = nanpa.slice(3, 6);
  const subscriber = nanpa.slice(6);

  // --- Invalid NANPA NPA patterns -----------------------------------------
  // NPAs starting with 0 or 1 are not valid in the NANPA. A number beginning
  // 000 or 055 on a CDR is either malformed or a spoofed attempt that the
  // carrier accepted anyway.
  if (npa[0] === "0" || npa[0] === "1") {
    signals.push({
      label: `Invalid NANPA area code (${npa})`,
      delta: -20,
      note:
        `Area code ${npa} is not a valid NANPA NPA — NANPA NPAs may not begin ` +
        "with 0 or 1. This number is either malformed in your CDR or was " +
        "spoofed through a carrier that did not enforce NANPA format. Do not " +
        "assume this is a real assigned number.",
      category: "number",
    });
    return signals;
  }
  if (N11_CODES.has(npa)) {
    signals.push({
      label: `N11 service code as area code (${npa})`,
      delta: -25,
      note:
        `${npa} is a reserved N11 service code (211/311/411/511/611/711/811/911) ` +
        "and is never valid as an originating NPA. This is a spoofed or " +
        "malformed CDR entry. Cannot be sued — there is no entity behind it.",
      category: "number",
    });
    return signals;
  }

  // --- Caribbean / territory NPAs -----------------------------------------
  if (CARIBBEAN_AND_TERRITORY_NPAS.has(npa)) {
    const isUsTerritory = US_TERRITORY_SOFT_NPAS.has(npa);
    if (isUsTerritory) {
      signals.push({
        label: `US-territory area code (${npa}) — outside CONUS service radius`,
        delta: -10,
        note:
          `Area code ${npa} belongs to a US territory (Puerto Rico, USVI, Guam, ` +
          "American Samoa, or Northern Marianas). US federal law applies but " +
          "your state small-claims court cannot reach the defendant — you would " +
          "need to file in the territorial court. Consider a class-action " +
          "referral or an FCC complaint instead.",
        category: "number",
      });
    } else {
      signals.push({
        label: `Caribbean +1 area code (${npa}) — international origin`,
        delta: -22,
        note:
          `Area code ${npa} is assigned to a Caribbean country in the NANPA. ` +
          "These numbers look like US numbers but are outside US civil-process " +
          "reach. Telemarketing from +1 Caribbean NPAs is a well-documented " +
          "scam pattern (the 'Jamaican lottery' 876 family, in particular). " +
          "Suing here almost always fails — pursue the US seller or file an " +
          "FCC complaint.",
        category: "number",
      });
    }
    // Continue analyzing — these numbers can still have repeating digit
    // patterns worth noting.
  }

  // --- Toll-free -----------------------------------------------------------
  if (TOLL_FREE_NPAS.has(npa)) {
    signals.push({
      label: `Toll-free area code (${npa})`,
      delta: -5,
      note:
        "Toll-free numbers hide the caller's geography but are leased through " +
        "US-based carriers. The current RespOrg assignee can be identified via " +
        "FCC RespOrg lookup (https://www.fcc.gov/general/resp-orgs) and/or " +
        "subpoena. See manual-research Step 4.",
      category: "number",
    });
  }

  // --- 900-series / 5XX-series -------------------------------------------
  if (npa.startsWith("9") && npa[1] === "0" && npa[2] === "0") {
    signals.push({
      label: "900-series originating number",
      delta: -20,
      note: "900-series are pay-per-call lines — not a commercial telemarketer profile. Either spoofed or a malformed CDR entry.",
      category: "number",
    });
  }
  if (FIVE_HUNDRED_SERIES.has(npa)) {
    signals.push({
      label: `500-series personal/VoIP area code (${npa})`,
      delta: -10,
      note:
        "5XX-series numbers are personal-communications-services lines, " +
        "typically VoIP/routed. Often disposable and backed by a reseller " +
        "with no direct relationship to the telemarketer.",
      category: "number",
    });
  }

  // --- Repeating / sequential / demo patterns -----------------------------
  const isRepeating = (s: string) => /^(\d)\1+$/.test(s);
  if (isRepeating(nxx) || isRepeating(subscriber)) {
    signals.push({
      label: "Repeating-digit exchange or subscriber block",
      delta: -10,
      note:
        "Repeating digits (e.g. 555, 1111, 0000) are common in spoofed or " +
        "disposable numbers. Memorable numbers ARE sold legitimately for high " +
        "premiums, so verify rather than assume — but weight collectability down.",
      category: "number",
    });
  }
  if (subscriber === "1212") {
    signals.push({
      label: "Test/demo-pattern subscriber number (1212)",
      delta: -10,
      note:
        "Subscriber block 1212 is a classic placeholder used in training " +
        "examples and by VoIP resellers. Genuine businesses rarely retain it.",
      category: "number",
    });
  }
  // Sequential ascending or descending 4-digit patterns (1234, 2345, 4321).
  const isSequential = (s: string): boolean => {
    if (s.length !== 4) return false;
    const nums = s.split("").map(Number);
    const diffs = [nums[1] - nums[0], nums[2] - nums[1], nums[3] - nums[2]];
    return diffs.every((d) => d === 1) || diffs.every((d) => d === -1);
  };
  if (isSequential(subscriber)) {
    signals.push({
      label: "Sequential-digit subscriber pattern",
      delta: -6,
      note:
        `Subscriber block ${subscriber} is a trivial ascending or descending ` +
        "sequence (e.g., 1234, 4321). These patterns over-index on test " +
        "numbers, VoIP demo blocks, and spoof dials. Soft signal only — " +
        "memorable sequences do sell legitimately.",
      category: "number",
    });
  }

  return signals;
}

/**
 * Caller-name analysis. Normalizes by stripping entity suffixes (LLC, Inc.,
 * Corp., etc.), punctuation, and leading "the ". Cross-references with the
 * companyName field — if companyName is specific, that's a positive signal
 * even if every callerName looks generic.
 */
function evaluateCallerNames(offender: OffenderProfile): Signal[] {
  const signals: Signal[] = [];
  const rawNames: string[] = [];
  const list = Array.isArray(offender.callerNames) ? offender.callerNames : [];
  for (const n of list) {
    const s = safeString(n, 200);
    if (s) rawNames.push(s);
  }
  const companyName = safeString(offender.companyName, 500);

  if (rawNames.length === 0 && !companyName) {
    signals.push({
      label: "No caller-identification captured",
      delta: -10,
      note:
        "No caller name was captured during any call, and the offender " +
        "profile has no companyName. Without an identified entity you cannot " +
        "sue — a court cannot enter judgment against a phone number. Review " +
        "recordings and transcripts for any self-identifying statement " +
        "('Hi, I'm calling from X on behalf of Y'). If none, listen further; " +
        "auto-warranty and medicare callers typically identify the seller " +
        "late in the pitch.",
      category: "identity",
    });
    return signals;
  }

  const specific = rawNames.filter((n) => !isGenericName(n));

  if (specific.length > 0) {
    signals.push({
      label: "Specific entity name(s) captured",
      delta: +10,
      note:
        "Observed identifier(s): " +
        specific.slice(0, 5).map((n) => safeDisplay(n, 100)).join(", ") +
        (specific.length > 5 ? `, +${specific.length - 5} more` : "") +
        ". Run each through the manual-research checklist below — a company " +
        "that identifies itself over the phone is usually in state " +
        "Secretary-of-State registries under that name or a DBA.",
      category: "identity",
    });
  } else if (rawNames.length > 0) {
    signals.push({
      label: "Only generic caller identifiers",
      delta: -8,
      note:
        "All observed caller names are generic (first names, department " +
        "labels, 'customer service'). Those do NOT identify a legal entity. " +
        "Listen for the SELLER — the company whose product is pitched " +
        "(warranty issuer, lender, insurance carrier). Under FCC 2013 DISH " +
        "Network, the seller is the real defendant, not the offshore agent.",
      category: "identity",
    });
  }

  // Cross-reference: if companyName is specific AND callerNames are generic,
  // the companyName alone is still a collectability boost — somebody (either
  // the user or a prior review) already resolved the entity.
  if (companyName && !isGenericName(companyName)) {
    // Only reward IF we didn't already reward a specific caller name (avoid
    // double-counting).
    if (specific.length === 0) {
      signals.push({
        label: "Offender profile has a specific companyName",
        delta: +8,
        note:
          `The offender profile identifies the defendant as "${safeDisplay(companyName, 200)}". ` +
          "This is a positive signal: someone already resolved the entity " +
          "behind the phone number. Verify that this name appears in the " +
          "state Secretary-of-State business registry (checklist Step 1).",
        category: "identity",
      });
    }
  }

  return signals;
}

/** Strip punctuation, entity suffixes, leading "the", collapse whitespace, lowercase. */
function normalizeEntityName(s: string): string {
  let x = s.toLowerCase().trim();
  // Strip common punctuation.
  x = x.replace(/[.,'"&;()\[\]{}!?]/g, " ");
  // Collapse whitespace.
  x = x.replace(/\s+/g, " ").trim();
  // Strip leading "the ".
  x = x.replace(/^the\s+/, "");
  // Iteratively strip trailing entity suffixes.
  let changed = true;
  while (changed) {
    changed = false;
    for (const suf of ENTITY_SUFFIXES) {
      if (x === suf) { x = ""; changed = true; break; }
      if (x.endsWith(" " + suf)) { x = x.slice(0, -suf.length - 1).trim(); changed = true; break; }
    }
  }
  return x;
}

function isGenericName(raw: string): boolean {
  const n = normalizeEntityName(raw);
  if (!n) return true;              // empty after suffix stripping
  if (n.length <= 2) return true;   // "a", "co"
  if (GENERIC_CALLER_NAMES.has(n)) return true;
  // Also match multi-word generics that include a generic head word.
  if (/\b(department|dept|services|support|compliance|sales|billing)\b/.test(n)) {
    // If EVERY word is generic, it's generic. If mixed (e.g., "Acme Services"
    // which has a specific brand "Acme"), treat as specific.
    const words = n.split(/\s+/);
    const allGeneric = words.every((w) => GENERIC_CALLER_NAMES.has(w) || /^(department|dept|services|support|compliance|sales|billing|of|and|the)$/.test(w));
    if (allGeneric) return true;
  }
  // Heuristic: a single first name (one token, all letters, looks name-ish)
  // without any other qualifier is generic.
  if (/^[a-z]{2,15}$/.test(n) && !/\d/.test(n) && GENERIC_CALLER_NAMES.has(n)) {
    return true;
  }
  return false;
}

/**
 * Neighbor-spoofing: the caller-ID NPA+NXX matches the user's own NPA+NXX.
 * This is a signature telemarketer trick — victims answer numbers that
 * "look local". A match at the NPA+NXX level is near-certainly spoofed
 * because a telemarketer cannot legitimately originate hundreds of calls
 * from the victim's own local exchange.
 */
function evaluateNeighborSpoof(
  offenderNumber: unknown,
  userPhone: unknown
): Signal[] {
  const offender10 = extractNanpa10(offenderNumber);
  const user10 = extractNanpa10(userPhone);
  if (!offender10 || !user10) return [];
  const offenderNpaNxx = offender10.slice(0, 6);
  const userNpaNxx = user10.slice(0, 6);
  if (offenderNpaNxx !== userNpaNxx) return [];
  return [{
    label: "Neighbor-spoofing: caller ID matches your NPA+NXX",
    delta: -18,
    note:
      `Caller ID +1${offender10.slice(0,3)}-${offender10.slice(3,6)}-${offender10.slice(6)} ` +
      `shares the first 6 digits with your own number. Legitimate businesses do ` +
      "not originate hundreds of calls from the victim's own local exchange — " +
      "this is a classic neighbor-spoofing pattern and the caller ID is almost " +
      "certainly fabricated. The TRUE originating carrier can only be found via " +
      "STIR/SHAKEN traceback. See ALTERNATIVES play 3.",
    category: "spoof",
  }];
}

/**
 * Persistence + time-of-day pattern. A long-running campaign with specific
 * names is a positive signal for collectability. Calls clustered outside
 * 8 AM–9 PM local time (the federal calling-hours window in 47 C.F.R.
 * Part 64 Subpart L) AND outside business hours more broadly are a separate
 * NEGATIVE signal — both because they're a § 227(c)(5) violation in their
 * own right and because night-time dialing indicates an automated/overseas
 * operation.
 *
 * TODO(citation-audit): this comment used to name the subsection as
 * § 64.1200(a)(1)(i); the citation registry flags that as the emergency-
 * lines subsection, not calling hours. No human on this project has
 * personally confirmed the correct subsection against the primary source
 * yet, so we reference the umbrella regulation only.
 */
function evaluatePersistenceAndTime(offender: OffenderProfile): Signal[] {
  const signals: Signal[] = [];
  const calls = Array.isArray(offender.calls) ? offender.calls : [];

  // --- Date-span / persistence -------------------------------------------
  if (offender.firstCallDate && offender.lastCallDate) {
    const first = Date.parse(offender.firstCallDate);
    const last = Date.parse(offender.lastCallDate);
    if (Number.isFinite(first) && Number.isFinite(last)) {
      // Tolerate reversed order: use absolute difference.
      const spanDays = Math.abs(Math.round((last - first) / 86_400_000));
      const callCount = Math.max(0, Math.min(10_000, Number.isFinite(offender.callCount) ? offender.callCount : 0));
      if (spanDays >= 90 && callCount >= 3) {
        signals.push({
          label: "Persistent campaign (>=90 days, >=3 calls)",
          delta: +8,
          note:
            `Originating number has been active for ${spanDays} days across ` +
            `${callCount} calls. Long-running campaigns are more often backed ` +
            "by established (and therefore reachable) operations than one-shot " +
            "disposables.",
          category: "pattern",
        });
      } else if (spanDays <= 7 && callCount <= 2) {
        signals.push({
          label: "Short-burst / one-shot number",
          delta: -5,
          note:
            `Number appeared for ${spanDays} day(s) across ${callCount} call(s). ` +
            "Short-burst numbers are commonly rotated VoIP rentals that vanish " +
            "before service of process can be attempted.",
          category: "pattern",
        });
      }
    }
  }

  // --- Time-of-day analysis ----------------------------------------------
  // Classify each call as in-window (8-21 local), evening (21-24), late-night
  // (0-8). We do NOT know the user's timezone precisely — the `time` field
  // in CallEntry is whatever the ingestion stored. For a single-user self-
  // hosted tool, assume it's user-local.
  let inWindow = 0;
  let late = 0;    // 21:00-07:59
  let invalid = 0;
  for (const c of calls) {
    const t = safeString(c?.time, 10);
    const m = /^(\d{1,2}):(\d{1,2})/.exec(t);
    if (!m) { invalid++; continue; }
    const h = parseInt(m[1], 10);
    const min = parseInt(m[2], 10);
    if (!Number.isFinite(h) || !Number.isFinite(min) || h < 0 || h > 23 || min < 0 || min > 59) {
      invalid++; continue;
    }
    // DNC window is 8:00–20:59 local. A call at 21:00 is already outside.
    if (h >= 8 && h < 21) inWindow++;
    else late++;
  }
  const totalValid = inWindow + late;
  if (totalValid >= 2) {
    const lateFrac = late / totalValid;
    if (lateFrac >= 0.6 && late >= 2) {
      signals.push({
        label: "Calls outside 8 AM–9 PM local (DNC-hour violations)",
        delta: -10,
        // TODO(citation-audit): this note used to cite § 64.1200(a)(1)(i)
        // as the calling-hours violation; the citation registry flags that
        // subsection as emergency-lines, not calling-hours. Removed pending
        // human verification of the correct subsection against the primary
        // source in eCFR. Narrative-only is the safer default.
        note:
          `${late} of ${totalValid} calls were placed before 8 AM or after 9 PM ` +
          "local time. This (a) is an independent TCPA calling-hours violation " +
          "(see 47 C.F.R. Part 64 Subpart L), giving you a separate $500/call " +
          "claim, and (b) strongly indicates an automated offshore dialer that " +
          "does not respect US-local business hours. Note every timestamp for " +
          "the prayer for relief.",
        category: "pattern",
      });
    } else if (late >= 1 && inWindow >= 1) {
      signals.push({
        label: "Mixed time-of-day pattern",
        delta: -3,
        note:
          `${late} of ${totalValid} calls fell outside 8 AM–9 PM local. Some ` +
          "calls in-window, some out. Pattern is consistent with a US-based " +
          "auto-dialer that occasionally misfires — collectability signal is " +
          "mildly negative, but the out-of-window calls are separately " +
          "actionable.",
        category: "pattern",
      });
    }
  }

  return signals;
}

/**
 * Transcript scam-phrase scan. Each call's transcriptSnippet is regex-tested
 * against known pitch patterns. The total penalty from transcripts is
 * CAPPED so a single call with many phrases does not nuke the score, but
 * repeated phrases across multiple calls compound up to the cap.
 */
function evaluateTranscripts(offender: OffenderProfile): Signal[] {
  const calls = Array.isArray(offender.calls) ? offender.calls : [];
  const hits = new Map<string, number>(); // tag -> occurrences
  for (const c of calls) {
    const tr = safeString(c?.transcriptSnippet, 5000);
    if (!tr) continue;
    for (const { re, tag } of SCAM_PHRASES) {
      if (re.test(tr)) {
        hits.set(tag, (hits.get(tag) ?? 0) + 1);
      }
    }
  }
  if (hits.size === 0) return [];
  // Cap: each tag counted at most once for scoring purposes; the overall
  // penalty cap is −20 (so transcripts can never drive the score lower than
  // about 10 on their own when all other signals are neutral).
  const uniqueTags: string[] = [];
  let totalDelta = 0;
  for (const [tag] of hits) {
    const entry = SCAM_PHRASES.find((p) => p.tag === tag);
    if (!entry) continue;
    uniqueTags.push(tag);
    totalDelta += entry.delta;
  }
  const CAP = -20;
  if (totalDelta < CAP) totalDelta = CAP;
  const countStr = uniqueTags.length === 1 ? "1 pattern" : `${uniqueTags.length} patterns`;
  return [{
    label: `Scam-script phrase(s) in call transcripts (${countStr})`,
    delta: totalDelta,
    note:
      "Transcript snippets contain language that matches known robocall " +
      "scam scripts: " + uniqueTags.slice(0, 5).join("; ") +
      (uniqueTags.length > 5 ? `; +${uniqueTags.length - 5} more` : "") +
      ". This is a content-based signal that the caller is an auto-dialer " +
      "running a scripted pitch rather than a real-business outreach. " +
      "Transcripts should still be reviewed manually before verifying.",
    category: "content",
  }];
}

/**
 * Entity-registry enrichment signals. Single source of truth for how a
 * Secretary-of-State / OpenCorporates result moves the collectability
 * needle.
 *
 * SCORING RATIONALE (these numbers are calibrated against the existing
 * 30-baseline / [0,100] clamp. Deltas are intentionally moderate — entity
 * status is one of many signals, not a verdict).
 *
 *   no_match          → -15  (user-chosen: registered=collectable proxy)
 *   match.dissolved   → -20  (judgment is uncollectable against a dead entity)
 *   match.inactive    → -10  (suspended / withdrawn — at best, costly)
 *   match.unknown     →   0  (we can't classify the registry's status)
 *   match.active      → +10  (good standing, base bonus)
 *     +5 if entity age > 5 years      (established business)
 *     -5 if entity age < 1 year       (suspicious / shell-fresh pattern)
 *   match.matchConfidence === "low"
 *                      → cap any positive delta at +2 (we MIGHT have the
 *                        wrong company; don't over-credit a fuzzy match)
 *   error / skipped   →   0  (no signal — never punish for tooling issues)
 */
function evaluateEntityEnrichment(entity: EntityEnrichment | undefined): Signal[] {
  if (!entity) return [];

  if (entity.status === "skipped" || entity.status === "error") {
    // Surface to the user via a 0-delta note so they can see WHY there's
    // no signal — but no scoring impact.
    const reason = entity.status === "skipped"
      ? (entity.reason ?? "Lookup not performed.")
      : (entity.errorMessage ?? "Registry lookup failed.");
    return [{
      label: "Entity registry lookup not used",
      delta: 0,
      note: `Business-registry lookup did not contribute to scoring. ${reason}`,
      category: "enrichment",
    }];
  }

  if (entity.status === "no_match") {
    const where = entity.jurisdictionCode ? ` in ${entity.jurisdictionCode}` : "";
    const q = entity.query ? ` for "${safeString(entity.query, 80)}"` : "";
    return [{
      label: "Entity registry: NO active filing found",
      delta: -15,
      note:
        `OpenCorporates returned zero matches${q}${where}. Real businesses ` +
        `that take consumer payments are normally registered with their state's ` +
        `Secretary of State. A no-match result strongly suggests either (a) the ` +
        `caller used a fake company name on the call, or (b) the entity is ` +
        `unregistered — both of which make collecting a small-claims judgment ` +
        `very difficult. Confirm with a manual search of your state's SoS site ` +
        `before drawing a final conclusion (the registry can sometimes miss DBAs ` +
        `or trade names).`,
      category: "enrichment",
    }];
  }

  // status === "match"
  const m = entity;
  const signals: Signal[] = [];
  const where = m.jurisdictionCode ? ` (${m.jurisdictionCode})` : "";
  const matchedSafe = safeString(m.matchedName, 120);

  switch (m.normalizedStatus) {
    case "active": {
      let baseDelta = +10;
      // Down-weight low-confidence name matches so we don't over-credit
      // a wrong company. A "low" match might be a coincidence in the
      // registry — show it to the user but don't bank on it.
      if (m.matchConfidence === "low") baseDelta = +2;
      signals.push({
        label: `Entity registry: ACTIVE — "${matchedSafe}"${where}`,
        delta: baseDelta,
        note:
          `Business-registry lookup returned an active filing. ${m.matchConfidence === "low"
            ? "Name match was loose — verify the matched name is actually your defendant before relying on this. "
            : ""}` +
          `An active, in-good-standing entity has a registered agent for ` +
          `service of process — meaning you can reliably serve them, and a ` +
          `judgment is collectable against the entity's assets. Verify at the ` +
          `OpenCorporates page in the report URL.`,
        category: "enrichment",
      });
      // Age-based modifier — only meaningful when status is active.
      const yrs = entityAgeYearsSafe(m.incorporationDate);
      if (typeof yrs === "number") {
        if (yrs > 5) {
          signals.push({
            label: `Entity established ~${yrs.toFixed(1)} years ago`,
            delta: +5,
            note: `An entity that has filed annual reports for >5 years is significantly less likely to be a shell or one-off scam vehicle.`,
            category: "enrichment",
          });
        } else if (yrs < 1) {
          signals.push({
            label: `Entity is brand new (~${(yrs * 12).toFixed(0)} months old)`,
            delta: -5,
            note: `A very recently incorporated entity is a yellow flag — many scam operations rotate shell entities every few months. Not dispositive (legitimate businesses are also new), but a signal.`,
            category: "enrichment",
          });
        }
      }
      break;
    }
    case "dissolved": {
      signals.push({
        label: `Entity registry: DISSOLVED — "${matchedSafe}"${where}`,
        delta: -20,
        note:
          `The matched entity is dissolved/terminated/forfeited per the ` +
          `registry. A judgment against a dissolved entity is functionally ` +
          `worthless — no assets, no registered agent, and you may have ` +
          `serious service-of-process problems (read: case dismissed before ` +
          `you ever reach the merits). Confirm the status via the source URL ` +
          `before filing. If you have evidence the SAME PEOPLE are operating ` +
          `under a NEW entity, that's a different (and stronger) case.`,
        category: "enrichment",
      });
      break;
    }
    case "inactive": {
      signals.push({
        label: `Entity registry: INACTIVE/SUSPENDED — "${matchedSafe}"${where}`,
        delta: -10,
        note:
          `The matched entity is inactive, suspended, or withdrawn per the ` +
          `registry. Even if the case is meritorious, collection is uncertain ` +
          `and service of process may be hard if the registered-agent filing ` +
          `is stale.`,
        category: "enrichment",
      });
      break;
    }
    case "unknown":
    default: {
      // Surface to user but no scoring impact — we don't understand the
      // raw status string and silently defaulting either way would be
      // dishonest.
      signals.push({
        label: `Entity registry: status unrecognized — "${matchedSafe}"${where}`,
        delta: 0,
        note:
          `Found a matching registry filing, but the registry returned a ` +
          `status string we don't recognize${m.rawStatus ? ` ("${safeString(m.rawStatus, 80)}")` : ""}. ` +
          `No scoring impact — verify status manually at the source URL.`,
        category: "enrichment",
      });
      break;
    }
  }

  return signals;
}

/** Local entity-age helper to avoid pulling openCorporatesClient into this module. */
function entityAgeYearsSafe(incorporationDate: string | null | undefined): number | null {
  if (!incorporationDate) return null;
  const d = new Date(incorporationDate);
  if (isNaN(d.getTime())) return null;
  const ms = Date.now() - d.getTime();
  if (ms < 0) return 0;
  return ms / (365.25 * 24 * 60 * 60 * 1000);
}

/**
 * Enrichment signals — only fire if the caller provides pre-fetched API
 * data via ResearchConfig.enrichment. Default path emits zero enrichment
 * signals.
 */
function evaluateEnrichment(en: EnrichmentResult | undefined): Signal[] {
  if (!en) return [];
  const signals: Signal[] = [];
  if (en.lineType) {
    const lt = en.lineType;
    if (lt.type === "voip") {
      signals.push({
        label: `Enrichment: VoIP line (${lt.carrier ?? "unknown carrier"})`,
        delta: -8,
        note: "Twilio Lookup / NumVerify reports this is a VoIP line — generally disposable and rented through a reseller.",
        category: "enrichment",
      });
    } else if (lt.type === "landline") {
      signals.push({
        label: `Enrichment: landline (${lt.carrier ?? "unknown carrier"})`,
        delta: +5,
        note: "Landline numbers are harder to spoof at the carrier level and usually indicate an assigned business line.",
        category: "enrichment",
      });
    } else if (lt.type === "mobile") {
      signals.push({
        label: `Enrichment: mobile line (${lt.carrier ?? "unknown carrier"})`,
        delta: 0,
        note: "Mobile line — neutral signal. Could be a legitimate business cell or a disposable prepaid.",
        category: "enrichment",
      });
    }
  }
  if (typeof en.consumerComplaintCount === "number" && en.consumerComplaintCount >= 10) {
    signals.push({
      label: `Enrichment: ${en.consumerComplaintCount}+ FCC/FTC complaints on file`,
      delta: -2,
      note: "Many prior consumer complaints against this number. Useful for a pattern-of-practice allegation, but a high complaint count also correlates with short-lived / disposable lines.",
      category: "enrichment",
    });
  }
  // Prior-litigation count, bucketed. Single biggest predictor of
  // small-claims TCPA outcome — a defendant with dozens of prior suits
  // is dramatically more likely to settle, has accessible counsel, and
  // has a documented payment history. A defendant with zero hits is
  // either brand new, only state-court (CourtListener doesn't index
  // those), or genuinely never been sued.
  if (typeof en.priorLitigationCount === "number" && en.priorLitigationCount >= 1) {
    let delta: number;
    let band: string;
    if (en.priorLitigationCount >= 11) {
      delta = +20; band = "11+";
    } else if (en.priorLitigationCount >= 3) {
      delta = +15; band = "3-10";
    } else {
      delta = +8; band = "1-2";
    }
    signals.push({
      label: `Enrichment: ${en.priorLitigationCount} prior federal TCPA suit(s) on record (${band} bucket)`,
      delta,
      note:
        `CourtListener / RECAP shows prior federal litigation against this ` +
        `defendant. Prior litigation means they are reachable, have counsel, ` +
        `and have a documented posture (settle / default / fight). The more ` +
        `prior cases, the more confident the prediction. Note: only federal ` +
        `cases are indexed; state-court small-claims TCPA suits would not ` +
        `appear here.`,
      category: "enrichment",
    });
  }
  // Richer entity lookup (OpenCorporates / state SoS). If present, takes
  // precedence over the legacy entityFoundInRegistry boolean. Scoring is
  // deliberately asymmetric — by product decision (Marcus 2026-04-18),
  // a no_match result penalizes collectability because in the small-claims
  // TCPA context, an un-registered "entity" overwhelmingly correlates
  // with fly-by-night operators that can't be collected against. Errors
  // and skipped lookups produce NO signal (can't penalize for our own
  // network problem).
  const entitySignals = evaluateEntityEnrichment(en.entity);
  signals.push(...entitySignals);

  // Legacy fallback — only if the newer `entity` is absent.
  if (entitySignals.length === 0 && en.entityFoundInRegistry) {
    signals.push({
      label: "Enrichment: entity confirmed in business registry",
      delta: +8,
      note: "An API lookup (OpenCorporates / state SoS) returned an active registration matching the companyName.",
      category: "enrichment",
    });
  }
  for (const note of en.notes ?? []) {
    signals.push({
      label: "Enrichment note",
      delta: 0,
      note: safeString(note, 500),
      category: "enrichment",
    });
  }
  return signals;
}

// ══════════════════════════════════════════════════════════════════════════
//  MAIN SCORING ENTRY POINT
// ══════════════════════════════════════════════════════════════════════════

/**
 * Compute a preliminary collectability score for the offender. Starts at a
 * baseline of 30 (neutral-to-pessimistic — the prior for unknown-defendant
 * small-claims TCPA cases is unfavorable) and moves up/down based on
 * available signals. The score is clamped to [0, 100] regardless of
 * signal-sum magnitude.
 *
 * Legacy signature (offender only). For neighbor-spoofing detection, use
 * `generateDefendantResearchReport` — it threads userPhone through.
 */
export function scoreCollectability(
  offender: OffenderProfile,
  cfg?: { userPhone?: string; enrichment?: EnrichmentResult }
): CollectabilityScore {
  const base = 30;
  let signals: Signal[] = [
    ...evaluateNumberSignals(offender?.normalizedNumber),
    ...evaluateCallerNames(offender),
    ...evaluatePersistenceAndTime(offender),
    ...evaluateTranscripts(offender),
    ...evaluateNeighborSpoof(offender?.normalizedNumber, cfg?.userPhone),
    ...evaluateEnrichment(cfg?.enrichment),
  ];
  // Ensure no NaN/Infinity leaks from any signal delta.
  signals = signals.map((s) => ({
    ...s,
    delta: Number.isFinite(s.delta) ? s.delta : 0,
    label: safeString(s.label, 200),
    note: safeString(s.note, 2000),
  }));
  const delta = signals.reduce((acc, s) => acc + s.delta, 0);
  let score = base + delta;
  if (!Number.isFinite(score)) score = base;
  score = Math.max(0, Math.min(100, Math.round(score)));
  const band: CollectabilityScore["band"] =
    score < 30 ? "LOW" : score < 60 ? "MEDIUM" : "HIGH";
  return { score, band, signals };
}

// ══════════════════════════════════════════════════════════════════════════
//  STATE REFERENCE LINKS (SoS + AG complaint)
// ══════════════════════════════════════════════════════════════════════════

export interface StateLinks {
  sosLabel: string;
  sosUrl: string;
  agLabel: string;
  agUrl: string;
}

/** 50-state Secretary of State business search + Attorney General consumer-complaint URL map. */
export function stateLinks(postal: string): StateLinks {
  const P = (postal ?? "").trim().toUpperCase();
  const map: Record<string, StateLinks> = {
    AL: { sosLabel: "Alabama SoS — Business Search",              sosUrl: "https://arc-sos.state.al.us/cgi/corpname.mbr/input",                                      agLabel: "Alabama AG — Consumer Complaint",             agUrl: "https://www.alabamaag.gov/consumercomplaint" },
    AK: { sosLabel: "Alaska Corporations — Business Search",      sosUrl: "https://www.commerce.alaska.gov/cbp/main/Search/Entities",                                agLabel: "Alaska AG — Consumer Protection",             agUrl: "https://law.alaska.gov/department/civil/consumer/cpindex.html" },
    AZ: { sosLabel: "Arizona Corporation Commission — eCorp",     sosUrl: "https://ecorp.azcc.gov/EntitySearch/Index",                                               agLabel: "Arizona AG — Consumer Complaint",             agUrl: "https://www.azag.gov/consumer/complaints" },
    AR: { sosLabel: "Arkansas SoS — Business Search",             sosUrl: "https://www.sos.arkansas.gov/corps/search_all.php",                                       agLabel: "Arkansas AG — Consumer Protection",           agUrl: "https://arkansasag.gov/consumer-protection/" },
    CA: { sosLabel: "California SoS — bizfile Online",            sosUrl: "https://bizfileonline.sos.ca.gov/search/business",                                        agLabel: "California AG — Consumer Complaint",          agUrl: "https://oag.ca.gov/contact/consumer-complaint-against-business-or-company" },
    CO: { sosLabel: "Colorado SoS — Business Search",             sosUrl: "https://www.sos.state.co.us/biz/BusinessEntityCriteriaExt.do",                            agLabel: "Colorado AG — File a Complaint",              agUrl: "https://coag.gov/file-complaint/" },
    CT: { sosLabel: "Connecticut CONCORD — Business Inquiry",     sosUrl: "https://service.ct.gov/business/s/onlinebusinesssearch",                                  agLabel: "Connecticut AG — Complaint Form",             agUrl: "https://portal.ct.gov/AG/Common/Complaint-Form-Landing-Page" },
    DE: { sosLabel: "Delaware Corporations — Entity Search",      sosUrl: "https://icis.corp.delaware.gov/ecorp/entitysearch/namesearch.aspx",                       agLabel: "Delaware AG — Consumer Protection",           agUrl: "https://attorneygeneral.delaware.gov/fraud/cpu/complaintonline/" },
    FL: { sosLabel: "Florida Sunbiz — Entity Search",             sosUrl: "https://search.sunbiz.org/Inquiry/CorporationSearch/ByName",                              agLabel: "Florida AG — Consumer Complaint",             agUrl: "https://www.myfloridalegal.com/consumer-protection" },
    GA: { sosLabel: "Georgia Corporations — Business Search",     sosUrl: "https://ecorp.sos.ga.gov/BusinessSearch",                                                 agLabel: "Georgia AG — Consumer Complaint",             agUrl: "https://consumer.georgia.gov/consumer-complaints/file-consumer-complaint" },
    HI: { sosLabel: "Hawaii Business Registration — Search",      sosUrl: "https://hbe.ehawaii.gov/documents/search.html",                                            agLabel: "Hawaii AG — Consumer Protection",             agUrl: "https://cca.hawaii.gov/ocp/" },
    ID: { sosLabel: "Idaho SoS — Business Search",                sosUrl: "https://sosbiz.idaho.gov/search/business",                                                agLabel: "Idaho AG — Consumer Protection",              agUrl: "https://www.ag.idaho.gov/consumer-protection/" },
    IL: { sosLabel: "Illinois SoS — Business Services",           sosUrl: "https://apps.ilsos.gov/businessentitysearch/",                                            agLabel: "Illinois AG — File a Complaint",              agUrl: "https://illinoisattorneygeneral.gov/consumer-protection/" },
    IN: { sosLabel: "Indiana INBiz — Business Search",            sosUrl: "https://bsd.sos.in.gov/publicbusinesssearch",                                             agLabel: "Indiana AG — Consumer Complaint",             agUrl: "https://www.in.gov/attorneygeneral/consumer-protection-division/file-a-complaint/" },
    IA: { sosLabel: "Iowa SoS — Business Search",                 sosUrl: "https://sos.iowa.gov/search/business/search.aspx",                                        agLabel: "Iowa AG — Consumer Complaint",                agUrl: "https://www.iowaattorneygeneral.gov/for-consumers/file-a-consumer-complaint" },
    KS: { sosLabel: "Kansas Business Center — Search",            sosUrl: "https://www.sos.ks.gov/eforms/BusinessEntity/Search.aspx",                                agLabel: "Kansas AG — Consumer Protection",             agUrl: "https://ag.ks.gov/file-a-complaint/consumer-complaint" },
    KY: { sosLabel: "Kentucky SoS — Business Search",             sosUrl: "https://web.sos.ky.gov/ftsearch/",                                                        agLabel: "Kentucky AG — Consumer Protection",           agUrl: "https://ag.ky.gov/Priorities/Consumer-Protection/Pages/default.aspx" },
    LA: { sosLabel: "Louisiana SoS — geauxBIZ",                   sosUrl: "https://coraweb.sos.la.gov/CommercialSearch/CommercialSearch.aspx",                       agLabel: "Louisiana AG — Consumer Protection (File a Complaint)", agUrl: "https://www.ag.state.la.us/Complaints" },
    ME: { sosLabel: "Maine SoS — Corporate Name Search",          sosUrl: "https://icrs.informe.org/nei-sos-icrs/ICRS",                                              agLabel: "Maine AG — Consumer Protection",              agUrl: "https://www.maine.gov/ag/consumer/complaints/" },
    MD: { sosLabel: "Maryland SDAT — Business Entity Search",     sosUrl: "https://egov.maryland.gov/BusinessExpress/EntitySearch",                                  agLabel: "Maryland AG — Consumer Protection",           agUrl: "https://www.marylandattorneygeneral.gov/Pages/CPD/complaint.aspx" },
    MA: { sosLabel: "Massachusetts Corporations — Search",        sosUrl: "https://corp.sec.state.ma.us/CorpWeb/CorpSearch/CorpSearch.aspx",                         agLabel: "Massachusetts AG — File a Complaint",         agUrl: "https://www.mass.gov/how-to/file-a-consumer-complaint" },
    MI: { sosLabel: "Michigan LARA — Business Entity Search",     sosUrl: "https://cofs.lara.state.mi.us/SearchApi/Search/Search",                                   agLabel: "Michigan AG — Consumer Complaint",            agUrl: "https://www.michigan.gov/ag/consumer-protection/complaints" },
    MN: { sosLabel: "Minnesota SoS — Business Search",            sosUrl: "https://mblsportal.sos.state.mn.us/Business/Search",                                      agLabel: "Minnesota AG — Report a Problem",             agUrl: "https://www.ag.state.mn.us/Office/Complaint.asp" },
    MS: { sosLabel: "Mississippi SoS — Business Search",          sosUrl: "https://corp.sos.ms.gov/corp/portal/c/page/corpBusinessIdSearch/portal.aspx",             agLabel: "Mississippi AG — Consumer Protection",        agUrl: "https://www.ago.state.ms.us/divisions/consumer-protection/file-a-consumer-complaint/" },
    MO: { sosLabel: "Missouri SoS — Business Search",             sosUrl: "https://bsd.sos.mo.gov/BusinessEntity/BESearch.aspx",                                     agLabel: "Missouri AG — Consumer Complaint",            agUrl: "https://ago.mo.gov/home/consumer-complaint" },
    MT: { sosLabel: "Montana SoS — Business Search",              sosUrl: "https://biz.sosmt.gov/search/business",                                                   agLabel: "Montana AG — File a Consumer Complaint",      agUrl: "https://dojmt.gov/consumer/consumer-complaints/" },
    NE: { sosLabel: "Nebraska SoS — Corp/Business Search",        sosUrl: "https://www.nebraska.gov/sos/corp/corpsearch.cgi",                                        agLabel: "Nebraska AG — Consumer Protection",           agUrl: "https://protectthegoodlife.nebraska.gov/file-complaint" },
    NV: { sosLabel: "Nevada SilverFlume — Business Search",       sosUrl: "https://esos.nv.gov/EntitySearch/OnlineEntitySearch",                                     agLabel: "Nevada AG — File a Complaint",                agUrl: "https://ag.nv.gov/Complaints/File_Complaint/" },
    NH: { sosLabel: "New Hampshire QuickStart — Business Search", sosUrl: "https://quickstart.sos.nh.gov/online/BusinessInquire",                                    agLabel: "New Hampshire AG — Consumer Protection",      agUrl: "https://www.doj.nh.gov/consumer/complaints/" },
    NJ: { sosLabel: "New Jersey Division of Revenue — Business Search", sosUrl: "https://www.njportal.com/DOR/BusinessNameSearch/",                                 agLabel: "New Jersey AG — Consumer Complaint",          agUrl: "https://www.njconsumeraffairs.gov/File-a-Complaint" },
    NM: { sosLabel: "New Mexico SoS — Business Search",           sosUrl: "https://portal.sos.state.nm.us/BFS/online/CorporationBusinessSearch",                    agLabel: "New Mexico AG — Consumer Complaint",          agUrl: "https://www.nmag.gov/consumer-protection/" },
    NY: { sosLabel: "New York Dept of State — Corporation Search",sosUrl: "https://apps.dos.ny.gov/publicInquiry/",                                                  agLabel: "New York AG — File a Complaint",              agUrl: "https://ag.ny.gov/complaints" },
    NC: { sosLabel: "North Carolina SoS — Business Search",       sosUrl: "https://www.sosnc.gov/online_services/search/by_title/_Business_Registration",            agLabel: "North Carolina AG — Consumer Complaint",      agUrl: "https://ncdoj.gov/file-a-complaint/consumer-complaint/" },
    ND: { sosLabel: "North Dakota First-Stop — Business Search",  sosUrl: "https://firststop.sos.nd.gov/search/business",                                            agLabel: "North Dakota AG — Consumer Protection",       agUrl: "https://attorneygeneral.nd.gov/consumer-resources/consumer-complaints/" },
    OH: { sosLabel: "Ohio SoS — Business Search",                 sosUrl: "https://businesssearch.ohiosos.gov/",                                                     agLabel: "Ohio AG — Consumer Complaint",                agUrl: "https://www.ohioattorneygeneral.gov/Individuals-and-Families/Consumers/File-a-Complaint" },
    OK: { sosLabel: "Oklahoma SoS — Business Search",             sosUrl: "https://www.sos.ok.gov/corp/corpInquiryFind.aspx",                                        agLabel: "Oklahoma AG — Consumer Protection",           agUrl: "https://www.oag.ok.gov/consumer-protection-unit" },
    OR: { sosLabel: "Oregon Business Registry — Search",          sosUrl: "https://sos.oregon.gov/business/Pages/find.aspx",                                         agLabel: "Oregon DOJ — Consumer Complaint",             agUrl: "https://justice.oregon.gov/complaints/" },
    PA: { sosLabel: "Pennsylvania Business Search",               sosUrl: "https://file.dos.pa.gov/search/business",                                                 agLabel: "Pennsylvania AG — Consumer Complaint",        agUrl: "https://www.attorneygeneral.gov/submit-a-complaint/" },
    RI: { sosLabel: "Rhode Island SoS — Business Search",         sosUrl: "https://business.sos.ri.gov/corpweb/CorpSearch/CorpSearch.aspx",                          agLabel: "Rhode Island AG — Consumer Complaint",        agUrl: "https://riag.ri.gov/consumer-protection" },
    SC: { sosLabel: "South Carolina Business Search",             sosUrl: "https://businessfilings.sc.gov/BusinessFiling/Entity/Search",                             agLabel: "South Carolina DCA — Consumer Complaint",     agUrl: "https://consumer.sc.gov/consumer-protection/complaint" },
    SD: { sosLabel: "South Dakota SoS — Business Search",         sosUrl: "https://sosenterprise.sd.gov/BusinessServices/Business/FilingSearch.aspx",                agLabel: "South Dakota AG — Consumer Protection",       agUrl: "https://consumer.sd.gov/fileacomplaint.aspx" },
    TN: { sosLabel: "Tennessee SoS — Business Search",            sosUrl: "https://tnbear.tn.gov/ECommerce/FilingSearch.aspx",                                        agLabel: "Tennessee AG — Consumer Complaint",           agUrl: "https://www.tn.gov/attorneygeneral/working-for-tennessee/consumer/complaints.html" },
    TX: { sosLabel: "Texas Comptroller — Taxable Entity Search",  sosUrl: "https://mycpa.cpa.state.tx.us/coa/",                                                      agLabel: "Texas AG — Consumer Complaint",               agUrl: "https://www.texasattorneygeneral.gov/consumer-protection/file-consumer-complaint" },
    UT: { sosLabel: "Utah Business Search",                       sosUrl: "https://secure.utah.gov/bes/",                                                            agLabel: "Utah Consumer Protection — Complaint",        agUrl: "https://dcp.utah.gov/file-a-complaint/" },
    VT: { sosLabel: "Vermont SoS — Business Search",              sosUrl: "https://bizfilings.vermont.gov/online/BusinessInquire",                                   agLabel: "Vermont AG — Consumer Complaint",             agUrl: "https://ago.vermont.gov/cap/file-a-consumer-complaint/" },
    VA: { sosLabel: "Virginia SCC — Business Entity Search",      sosUrl: "https://cis.scc.virginia.gov/EntitySearch/Index",                                         agLabel: "Virginia AG — Consumer Complaint",            agUrl: "https://www.oag.state.va.us/consumer-protection/index.php/file-a-complaint" },
    WA: { sosLabel: "Washington Corporations and Charities",      sosUrl: "https://ccfs.sos.wa.gov/",                                                                agLabel: "Washington AG — File a Complaint",            agUrl: "https://www.atg.wa.gov/file-complaint" },
    WV: { sosLabel: "West Virginia SoS — Business Search",        sosUrl: "https://apps.sos.wv.gov/business/corporations/",                                           agLabel: "West Virginia AG — Consumer Protection",      agUrl: "https://ago.wv.gov/consumerprotection/" },
    WI: { sosLabel: "Wisconsin DFI — Corporate Records Search",   sosUrl: "https://www.wdfi.org/apps/CorpSearch/Search.aspx",                                         agLabel: "Wisconsin DATCP — Consumer Complaint",        agUrl: "https://datcp.wi.gov/Pages/Programs_Services/FileAConsumerComplaint.aspx" },
    WY: { sosLabel: "Wyoming SoS — Business Search",              sosUrl: "https://wyobiz.wyo.gov/Business/FilingSearch.aspx",                                        agLabel: "Wyoming AG — Consumer Protection",            agUrl: "https://ag.wyo.gov/consumer-protection-and-antitrust-unit" },
    DC: { sosLabel: "DC Corporations Online — Business Search",   sosUrl: "https://corponline.dcra.dc.gov/BizEntity.aspx/ViewEntitySearch",                          agLabel: "DC Office of AG — Consumer Complaint",        agUrl: "https://oag.dc.gov/consumer-protection" },
  };
  return map[P] ?? {
    sosLabel: `${P} Secretary of State — Business Search`,
    sosUrl: "https://www.nass.org/business-services",
    agLabel: `${P} Attorney General — Consumer Protection`,
    agUrl: "https://www.naag.org/find-my-ag/",
  };
}

/**
 * Call-type specific research pointer. Returns a block of text suggesting
 * regulator lookups specific to the kind of pitch in the call transcripts.
 */
function callTypeSpecificResearch(offender: OffenderProfile): string | null {
  const calls = Array.isArray(offender.calls) ? offender.calls : [];
  const blob = calls.map((c) => safeString(c?.transcriptSnippet, 5000)).join(" ").toLowerCase();
  const hits: string[] = [];
  if (/\bauto.*warranty|vehicle.*warranty|extended.*service.*contract/.test(blob)) {
    hits.push(
      "AUTO-WARRANTY CALLS — The issuer is usually a vehicle service contract\n" +
      "(VSC) company regulated by your state insurance commissioner (VSCs are\n" +
      "classified as motor-club-service or mechanical-breakdown insurance in\n" +
      "most states). Lookup:\n" +
      "  https://naic.org/state_contacts/sid_websites.htm\n" +
      "Known VSC issuers to check for: CarShield, Endurance, Omega Auto Care,\n" +
      "Olive, Toco Warranty, Palmer Administrative, Protect My Car, American\n" +
      "Auto Shield. Any of these named in the recordings IS the defendant."
    );
  }
  if (/\bsolar\s+(panel|energy|power)|rooftop\s+solar/.test(blob)) {
    hits.push(
      "SOLAR CALLS — Solar installers are licensed at the state level\n" +
      "(contractor license board + sometimes a separate solar registry).\n" +
      "Lookup:\n" +
      "  NABCEP Certified Professional Directory: https://www.nabcep.org/certified-locator/\n" +
      "  Your state contractor license board (search '[state] contractor license')"
    );
  }
  if (/\bmedicare\s+(card|plan|benefit|supplement|advantage)/.test(blob)) {
    hits.push(
      "MEDICARE CALLS — The seller is an insurance broker or a Medicare\n" +
      "Advantage carrier. CMS has a fraud reporting channel AND the carrier's\n" +
      "broker-of-record is searchable:\n" +
      "  CMS Medicare complaints: https://www.medicare.gov/my/medicare-complaint\n" +
      "  NIPR broker licensure: https://nipr.com/licensing-center"
    );
  }
  if (/\b(student\s+loan|loan\s+forgiveness|debt\s+relief|debt\s+consolidation)/.test(blob)) {
    hits.push(
      "DEBT-RELIEF / LOAN CALLS — Debt-relief companies are regulated\n" +
      "under the FTC Telemarketing Sales Rule 16 CFR Part 310. Complaint\n" +
      "channels:\n" +
      "  CFPB: https://www.consumerfinance.gov/complaint/\n" +
      "  FTC: https://reportfraud.ftc.gov/\n" +
      "  Your state banking/financial-services regulator"
    );
  }
  if (/\bcredit\s+card.*(lower|interest|rate)|debt\s+consolidat/.test(blob)) {
    hits.push(
      "CREDIT-CARD INTEREST-RATE CALLS — These are almost always lead-\n" +
      "generator scams. The true principal is often a state-licensed debt\n" +
      "settlement or consolidation company. Check CFPB and state financial\n" +
      "regulator as above; also the FTC's Don't Get Caught in a\n" +
      "Credit-Card-Rate Scam enforcement page."
    );
  }
  if (hits.length === 0) return null;
  return hits.join("\n\n");
}

// ══════════════════════════════════════════════════════════════════════════
//  REPORT RENDERING
// ══════════════════════════════════════════════════════════════════════════

/** URL-encode a raw user-provided string for safe inclusion in a URL. */
function urlEncode(s: string): string {
  return encodeURIComponent(safeString(s, 200));
}

/**
 * Executive summary at the top of the report: one paragraph, plain English,
 * action-oriented. This is the most important part of the document — a
 * busy user may read only this.
 */
function renderExecutiveSummary(
  score: CollectabilityScore,
  offender: OffenderProfile,
): string {
  const recommendation =
    score.band === "LOW"
      ? "DO NOT FILE YET — research first."
      : score.band === "MEDIUM"
        ? "PROCEED WITH CAUTION — complete the checklist before filing."
        : "LIKELY OK TO PROCEED — still complete the checklist.";
  const worstSignals = [...score.signals]
    .filter((s) => s.delta < 0)
    .sort((a, b) => a.delta - b.delta)
    .slice(0, 3)
    .map((s) => `  • ${s.label}`);
  const bestSignals = [...score.signals]
    .filter((s) => s.delta > 0)
    .sort((a, b) => b.delta - a.delta)
    .slice(0, 3)
    .map((s) => `  • ${s.label}`);
  const lines: string[] = [];
  lines.push("═══════════════════════════════════════════════════════════════════════");
  lines.push("  EXECUTIVE SUMMARY (read this first)");
  lines.push("═══════════════════════════════════════════════════════════════════════");
  lines.push("");
  lines.push(`  Collectability score:  ${score.score} / 100  [${score.band}]`);
  lines.push(`  Recommendation:        ${recommendation}`);
  lines.push("");
  const companyName = safeDisplay(offender.companyName, 200);
  if (companyName) {
    lines.push(`  Candidate defendant:   ${companyName}`);
  } else {
    lines.push(`  Candidate defendant:   (NONE IDENTIFIED — this is the single biggest blocker)`);
  }
  lines.push(`  Originating number:    ${safePhoneDisplay(offender.normalizedNumber)}`);
  lines.push("");
  if (worstSignals.length > 0) {
    lines.push("  Biggest collectability risks:");
    for (const l of worstSignals) lines.push(l);
    lines.push("");
  }
  if (bestSignals.length > 0) {
    lines.push("  Positive collectability signals:");
    for (const l of bestSignals) lines.push(l);
    lines.push("");
  }
  lines.push("  NEXT STEPS:");
  if (score.band === "LOW") {
    lines.push("    1. Read the ALTERNATIVES section (end of this document) before");
    lines.push("       spending any more time on a small-claims filing.");
    lines.push("    2. Try to identify the SELLER (the company whose product is being");
    lines.push("       pitched) from the recordings — that seller is the real");
    lines.push("       defendant under FCC 2013 DISH Network seller-liability doctrine.");
    lines.push("    3. File administrative complaints (FCC, FTC, state AG) in parallel");
    lines.push("       — they are free and create the paper trail a class-action firm");
    lines.push("       will ultimately use.");
  } else {
    lines.push("    1. Complete every item in the MANUAL RESEARCH CHECKLIST below.");
    lines.push("    2. Confirm the defendant is an ACTIVE entity in a business registry");
    lines.push("       with a reachable registered agent.");
    lines.push("    3. Only after Steps 1-2 produce green checks should you sign the");
    lines.push("       petition's sworn verification and pay the filing fee.");
  }
  lines.push("");
  return lines.join("\n");
}

function renderAutomatedSignals(score: CollectabilityScore): string {
  const lines: string[] = [];
  lines.push("───────────────────────────────────────────────────────────────────────");
  lines.push("AUTOMATED HEURISTIC FINDINGS (preliminary only)");
  lines.push("───────────────────────────────────────────────────────────────────────");
  lines.push("");
  lines.push(`Preliminary collectability score: ${score.score} / 100  [${score.band}]`);
  lines.push("");
  lines.push("These signals are computed from the offender's phone number, caller");
  lines.push("names captured during calls, transcript content, and call pattern.");
  lines.push("They are NOT proof — they are priors to weight your manual research.");
  lines.push("");
  if (score.signals.length === 0) {
    lines.push("  (no notable signals)");
  } else {
    // Sort: largest-magnitude negative first, then positives.
    const sorted = [...score.signals].sort((a, b) => a.delta - b.delta);
    for (const s of sorted) {
      const sign = s.delta > 0 ? `+${s.delta}` : `${s.delta}`;
      const pad = sign.padStart(4, " ");
      lines.push(`  [${pad}] ${s.label}`);
      for (const ln of s.note.split("\n")) {
        lines.push(`         ${ln}`);
      }
      lines.push("");
    }
  }
  lines.push("INTERPRETATION GUIDE:");
  lines.push("  LOW    (score 0–29)  — defendant is likely unreachable or a shell.");
  lines.push("                         Read ALTERNATIVES before spending a filing fee.");
  lines.push("  MEDIUM (score 30–59) — defendant may be reachable with diligence.");
  lines.push("                         Complete the manual checklist before filing.");
  lines.push("  HIGH   (score 60+)   — defendant shows signs of reachability.");
  lines.push("                         Still complete the manual checklist.");
  lines.push("");
  return lines.join("\n");
}

function renderChecklist(offender: OffenderProfile, cfg: ResearchConfig): string {
  const links = stateLinks(cfg.courtState);
  const numberDigitsOnly = digitsOnly(offender?.normalizedNumber);
  const firstCaller = Array.isArray(offender?.callerNames) && offender.callerNames.length > 0
    ? safeString(offender.callerNames[0], 100)
    : "";
  const companyName = safeString(offender?.companyName, 200);
  const entityQuery = companyName || firstCaller;
  const googleQuery = entityQuery
    ? urlEncode(`"${entityQuery}" telemarketer complaints ${numberDigitsOnly}`)
    : urlEncode(`${numberDigitsOnly} telemarketer complaints`);
  const lines: string[] = [];
  lines.push("───────────────────────────────────────────────────────────────────────");
  lines.push("MANUAL RESEARCH CHECKLIST");
  lines.push("───────────────────────────────────────────────────────────────────────");
  lines.push("");
  lines.push("Complete every step below BEFORE signing the petition verification.");
  lines.push("Record findings in the [ ] boxes. A missing step = unverified claim =");
  lines.push("risk of dismissal, sanctions, or an uncollectable default judgment.");
  lines.push("");
  lines.push("[ ] STEP 1 — SECRETARY OF STATE ENTITY LOOKUP (DEFINITIVE)");
  lines.push("    Search the suspected defendant name in the state of its principal");
  lines.push("    place of business. If the caller did NOT identify a business name,");
  lines.push("    skip to Step 2 and return after you have a candidate name.");
  lines.push("");
  lines.push(`    Your state (${safeString(cfg.courtStateLong, 50)}):`);
  lines.push(`      ${links.sosLabel}`);
  lines.push(`      ${links.sosUrl}`);
  lines.push("");
  lines.push("    Other common states for telemarketing operations:");
  lines.push("      Delaware:   https://icis.corp.delaware.gov/ecorp/entitysearch/namesearch.aspx");
  lines.push("      Florida:    https://search.sunbiz.org/Inquiry/CorporationSearch/ByName");
  lines.push("      Texas:      https://mycpa.cpa.state.tx.us/coa/");
  lines.push("      Nevada:     https://esos.nv.gov/EntitySearch/OnlineEntitySearch");
  lines.push("      California: https://bizfileonline.sos.ca.gov/search/business");
  lines.push("");
  lines.push("    Multi-state at once:");
  lines.push("      OpenCorporates: https://opencorporates.com/companies?q=" +
    (entityQuery ? urlEncode(entityQuery) : "{company-name}"));
  lines.push("");
  lines.push("    Record the findings:");
  lines.push("      Entity name (exact):       ___________________________________");
  lines.push("      State of registration:     ___________________________________");
  lines.push("      Status (active/dissolved): ___________________________________");
  lines.push("      Registered agent name:     ___________________________________");
  lines.push("      Registered agent address:  ___________________________________");
  lines.push("      Filing number:             ___________________________________");
  lines.push("");
  lines.push("    GATING RULE: if the entity is DISSOLVED or NOT FOUND, you cannot");
  lines.push("    recover from it. Either identify the correct entity (is this a DBA");
  lines.push("    of a parent company?), sue up the chain (ALTERNATIVES play 1), or");
  lines.push("    do not file.");
  lines.push("");
  lines.push("[ ] STEP 2 — FCC CONSUMER COMPLAINT DATABASE");
  lines.push("    Search the phone number to see if other consumers have complained");
  lines.push("    about this number and whether the FCC has identified an operator.");
  lines.push("");
  lines.push(`      https://consumercomplaints.fcc.gov/hc/en-us/search?query=${urlEncode(numberDigitsOnly)}`);
  lines.push("      https://opendata.fcc.gov/resource/sr6c-syda (raw complaint data)");
  lines.push("");
  lines.push("    Record the findings:");
  lines.push("      Number of complaints filed: _________");
  lines.push("      Associated company names:   ___________________________________");
  lines.push("      Date range of complaints:   ___________________________________");
  lines.push("");
  lines.push("[ ] STEP 3 — SPAM-CALL DATABASES (COMMUNITY REPORTS)");
  lines.push("    These sites aggregate consumer reports and frequently name the");
  lines.push("    underlying operation before the FCC or state AG does.");
  lines.push("");
  lines.push(`      YouMail:    https://directory.youmail.com/phone/${urlEncode(numberDigitsOnly)}`);
  lines.push(`      Nomorobo:   https://www.nomorobo.com/lookup/${urlEncode(numberDigitsOnly)}`);
  lines.push(`      800notes:   https://800notes.com/Phone.aspx/${urlEncode(numberDigitsOnly)}`);
  lines.push(`      Whitepages: https://www.whitepages.com/phone/${urlEncode(numberDigitsOnly)}`);
  lines.push(`      Google:     https://www.google.com/search?q=${googleQuery}`);
  lines.push("");
  lines.push("    Record the findings:");
  lines.push("      Most-reported company name: ___________________________________");
  lines.push("      Consistent across sources?: [ ] Yes   [ ] No");
  lines.push("");
  lines.push("[ ] STEP 4 — CARRIER / VOIP TRACEBACK (IF NUMBER APPEARS SPOOFED)");
  lines.push("    If Steps 1–3 return no real entity, the number is likely VoIP-");
  lines.push("    resold or spoofed. Identify the originating carrier:");
  lines.push("");
  lines.push("      FCC LERG / Number Administration:");
  lines.push(`        https://www.telcodata.us/telco-prefix-lookup-area-code-${numberDigitsOnly.slice(0, 3) || "XXX"}`);
  lines.push(`        https://www.atis.org/01_strategic/sso_docs/nrua/ (official lookup)`);
  lines.push("");
  lines.push("      STIR/SHAKEN traceback (Industry Traceback Group):");
  lines.push("        https://tracebacks.org — file a traceback request");
  lines.push("");
  lines.push("      Your own carrier's fraud team (faster path):");
  lines.push("        Call *611 or your carrier's fraud/abuse line and request a");
  lines.push("        STIR/SHAKEN trace for the dates in your evidence log.");
  lines.push("");
  lines.push("    Record the findings:");
  lines.push("      Originating carrier:   ___________________________________");
  lines.push("      Originating state:     ___________________________________");
  lines.push("      Attestation level:     [ ] A   [ ] B   [ ] C   [ ] unknown");
  lines.push("");
  lines.push("[ ] STEP 5 — LITIGATION HISTORY (PRIOR SUITS AGAINST DEFENDANT)");
  lines.push("    A defendant who has been sued for TCPA violations before is");
  lines.push("    (a) reachable, (b) has a litigation posture on file, and");
  lines.push("    (c) may already be in a settlement program you can join.");
  lines.push("");
  lines.push("      PACER (federal courts, $0.10/page):");
  lines.push("        https://pcl.uscourts.gov/pcl/index.jsf");
  lines.push("");
  lines.push("      CourtListener (free federal search):");
  lines.push("        https://www.courtlistener.com/");
  lines.push("");
  lines.push("      RECAP Archive (free federal docket cache):");
  lines.push("        https://www.courtlistener.com/recap/");
  lines.push("");
  lines.push("      State court records (search '[your state] court case search'):");
  lines.push(`        ${safeString(cfg.courtStateLong, 50)} uses separate clerk-of-court portals`);
  lines.push("        per parish/county; the SoS business record lists litigation");
  lines.push("        history for some entities.");
  lines.push("");
  lines.push("    Record the findings:");
  lines.push("      Prior TCPA cases filed:  _______________");
  lines.push("      Defendant counsel firm:  ___________________________________");
  lines.push("      Outcome pattern:         [ ] settles    [ ] defaults    [ ] fights");
  lines.push("");
  lines.push("[ ] STEP 6 — ASSET AND COLLECTABILITY CHECK");
  lines.push("    Verify the defendant has actual assets or licensure you can");
  lines.push("    garnish or levy if you win.");
  lines.push("");
  lines.push("      State licensure databases (varies by industry):");
  lines.push("        Auto-warranty/insurance:  https://naic.org/state_contacts/sid_websites.htm");
  lines.push("        Securities:               https://brokercheck.finra.org/");
  lines.push("        Debt collect/financial:   state financial-regulator registry");
  lines.push("        Solar installer:          https://www.nabcep.org/certified-locator/");
  lines.push("");
  lines.push("      Business financial signals:");
  lines.push("        [ ] Entity has a physical address a process server can reach");
  lines.push("        [ ] Active website at a custom domain (not just a Facebook page)");
  lines.push("        [ ] Listed phone number at published address matches caller ID");
  lines.push("        [ ] Recent reviews on Google Business / Yelp / BBB");
  lines.push("        [ ] Registered with the Better Business Bureau");
  lines.push("        [ ] Industry licensure on file with state regulator");
  lines.push("");
  lines.push("    Record the findings:");
  lines.push("      Physical address:       ___________________________________");
  lines.push("      Industry regulator:     ___________________________________");
  lines.push("      Active licensure #:     ___________________________________");
  lines.push("      Est. enforceability:    [ ] High  [ ] Medium  [ ] Low  [ ] None");
  lines.push("");
  // Call-type specific block, inserted as Step 6.5.
  const callTypeBlock = callTypeSpecificResearch(offender);
  if (callTypeBlock) {
    lines.push("[ ] STEP 6.5 — CALL-TYPE-SPECIFIC REGULATOR (based on transcript content)");
    for (const ln of callTypeBlock.split("\n")) {
      lines.push("    " + ln);
    }
    lines.push("");
  }
  lines.push("[ ] STEP 7 — STATE-AG PARALLEL COMPLAINT");
  lines.push("    File a consumer-protection complaint with your state AG in parallel");
  lines.push("    with the small-claims action. It's free, it creates a record, and");
  lines.push("    in a subpoena-ready format it's admissible under FRE 803(8).");
  lines.push("");
  lines.push(`      ${links.agLabel}`);
  lines.push(`      ${links.agUrl}`);
  lines.push("");
  lines.push("[ ] STEP 8 — FINAL GO/NO-GO GATE");
  lines.push("    BEFORE signing the petition verification, confirm ALL of the");
  lines.push("    following are TRUE. If ANY is false, read the ALTERNATIVES");
  lines.push("    section below before filing.");
  lines.push("");
  lines.push("      [ ] I have identified a specific legal entity to sue");
  lines.push("      [ ] That entity is ACTIVE in a state business registry");
  lines.push("      [ ] I have the registered agent's name and service address");
  lines.push("      [ ] The entity is reachable — physical address or agent exists");
  lines.push("      [ ] I have reasonable evidence the entity has assets or");
  lines.push("          licensure I could levy against if I win");
  lines.push("      [ ] The collectability score above is MEDIUM or HIGH");
  lines.push("          (if LOW, either raise the score with new evidence or don't file)");
  lines.push("");
  lines.push("    If any box is unchecked, DO NOT file this petition yet. Either");
  lines.push("    continue research, pursue the seller up the chain (ALTERNATIVES");
  lines.push("    play 1), or redirect effort to administrative complaints.");
  lines.push("");
  return lines.join("\n");
}

function renderAlternatives(offender: OffenderProfile, band: CollectabilityScore["band"]): string {
  const full = band === "LOW";
  // Render the phone number through the strict phone-safe formatter. Never
  // echo the raw normalizedNumber — it may contain injection payloads from
  // upstream data sources. digits-only is used for URL construction.
  const normalized = safePhoneDisplay(offender?.normalizedNumber);
  const digits = digitsOnly(offender?.normalizedNumber);
  const header =
    "───────────────────────────────────────────────────────────────────────\n" +
    "ALTERNATIVES IF YOU CANNOT REACH THIS DEFENDANT\n" +
    "───────────────────────────────────────────────────────────────────────\n\n" +
    (full
      ? "Your preliminary collectability score is LOW. Read this section\n" +
        "carefully BEFORE spending a filing fee. A judgment you cannot\n" +
        "collect is worse than no judgment at all — it costs money, time,\n" +
        "and hope, and buys you nothing.\n\n"
      : "Even with a reachable defendant, these parallel plays strengthen\n" +
        "your position and protect other consumers. Running all of them in\n" +
        "parallel is routine practice.\n\n");

  const plays = [
    {
      n: 1,
      title: "SUE UP THE CHAIN (seller liability)",
      body:
        "The TCPA makes the SELLER — the company on whose behalf the calls\n" +
        "were placed — liable for calls made by their agents, even offshore\n" +
        "agents. This was settled by the FCC's 2013 DISH Network ruling\n" +
        "(In re Joint Petition, 28 FCC Rcd 6574) and has been affirmed by\n" +
        "multiple circuits.\n\n" +
        "WHAT TO DO: listen to the recordings and identify the PRODUCT or\n" +
        "the ISSUER. Auto-warranty calls ultimately pitch a named company's\n" +
        "contract (CarShield, Endurance, Omega Auto Care, etc.). Solar calls\n" +
        "pitch a named installer. Medicare calls pitch a named insurer.\n" +
        "That named company IS the defendant — not the offshore call center,\n" +
        "not the spoofed number.\n\n" +
        "Look for phrases like 'on behalf of ___', 'we work with ___', or\n" +
        "'your policy would be with ___'. Those fill-in-the-blanks name\n" +
        "the real defendant.",
    },
    {
      n: 2,
      title: "FILE ADMINISTRATIVE COMPLAINTS IN PARALLEL",
      body:
        "These do not pay you directly, but they (a) create a public paper\n" +
        "trail that class-action firms actively mine, (b) give carriers the\n" +
        "leverage to block the number at network level under the TRACED Act\n" +
        "and STIR/SHAKEN rules, and (c) occasionally trigger an enforcement\n" +
        "action that results in consumer-restitution funds.\n\n" +
        "    1. FCC TCPA Complaint: https://consumercomplaints.fcc.gov/\n" +
        "    2. FTC Do Not Call: https://www.donotcall.gov/report.html\n" +
        "    3. State Attorney General consumer-protection complaint\n" +
        "       (search '[your state] attorney general consumer complaint')\n" +
        "    4. Better Business Bureau: https://www.bbb.org/file-a-complaint\n" +
        "    5. CFPB (for debt-relief / financial pitches):\n" +
        "       https://www.consumerfinance.gov/complaint/\n\n" +
        "File all five for each offender. It takes about 20 minutes total.\n" +
        "Include the specific dates/times of calls and attach your evidence\n" +
        "if the form allows uploads.",
    },
    {
      n: 3,
      title: "REQUEST AN ORIGINATING-CARRIER TRACE",
      body:
        "Under the TRACED Act and FCC rules (47 CFR § 64.1200(k)), carriers\n" +
        "must cooperate to trace the originating carrier of spoofed calls.\n" +
        "Your own carrier's fraud/abuse team can initiate this trace on your\n" +
        "behalf. The originating carrier then has records of the customer\n" +
        "who bought the number — that customer is usually a US-based VoIP\n" +
        "reseller whose agreements with their downstream customer (the\n" +
        "telemarketer) are discoverable.\n\n" +
        "WHAT TO DO: call your carrier, ask for the fraud department,\n" +
        "explicitly request a 'STIR/SHAKEN traceback' for calls from\n" +
        `${normalized} on the specific dates in your evidence log. Some\n` +
        "carriers route this through the Industry Traceback Group (ITG)\n" +
        "at https://tracebacks.org — you can also file directly with the ITG.",
    },
    {
      n: 4,
      title: "CLASS-ACTION REFERRAL",
      body:
        "If the number has been calling many people, a TCPA plaintiff's\n" +
        "firm will take the case on contingency against the US principal\n" +
        "(the seller) — you do not have to lead the class, you just have to\n" +
        "be documented evidence on their docket. Your SpamSlayer package is\n" +
        "exactly what they want.\n\n" +
        "Firms with active TCPA class-action dockets include (non-exhaustive,\n" +
        "not an endorsement): Edelson PC (edelson.com), Lieff Cabraser\n" +
        "(lieffcabraser.com), Kazerouni Law Group (kazlg.com), Parasmo Lieberman\n" +
        "(parasmolaw.com). Search each firm's 'current cases' page for your\n" +
        "defendant's name or product, and submit a contact form with your\n" +
        "evidence. Referrals are free.\n\n" +
        "You can also post your number and dates to community threads like\n" +
        "r/tcpa on Reddit — other victims have often already identified the\n" +
        "seller.",
    },
    {
      n: 5,
      title: "CROSS-REFERENCE SPAM-CALL DATABASES",
      body:
        "Third-party spam databases aggregate consumer reports on bad\n" +
        "numbers and often have already identified the underlying operation:\n\n" +
        "    • YouMail Directory:   https://directory.youmail.com/phone/" + urlEncode(digits) + "\n" +
        "    • Nomorobo Lookup:     https://www.nomorobo.com/lookup/" + urlEncode(digits) + "\n" +
        "    • Hiya reports:        https://www.hiya.com/identity (lookup by number)\n" +
        "    • 800notes community:  https://800notes.com/Phone.aspx/" + urlEncode(digits) + "\n" +
        "    • Reverse lookup:      https://www.whitepages.com/phone/" + urlEncode(digits) + "\n\n" +
        "If multiple reports name the same company, that confirms the seller\n" +
        "and is admissible as evidence of pattern (under FRE 404(b) and LA\n" +
        "C.E. Art. 404(B)) when combined with your own recordings.",
    },
    {
      n: 6,
      title: "BLOCK AT THE CARRIER LEVEL AND MOVE ON",
      body:
        "Not every number is worth litigating. If (a) collectability is LOW,\n" +
        "(b) the seller cannot be identified from the recordings, and\n" +
        "(c) the administrative complaints above have been filed, the most\n" +
        "rational play is often to block the number at the network level\n" +
        "and redirect your effort to the next actionable offender.\n\n" +
        "Enable enhanced spam blocking with your carrier (each carrier has\n" +
        "a free tier as required by TRACED). For numbers that slip through,\n" +
        "use Nomorobo, RoboKiller, or the native blocking in iOS/Android.\n" +
        "Keep the evidence package — if a class action later emerges, your\n" +
        "data is ready.",
    },
    {
      n: 7,
      title: "LEAD-GENERATOR / DATA-BROKER LIABILITY",
      body:
        "Under TCPA, a lead-generator or data broker who sold your number\n" +
        "to a telemarketer can be liable under § 227(c) if you did not\n" +
        "provide lawful prior express written consent. Lead generators are\n" +
        "almost always US-based and almost always have assets.\n\n" +
        "WHAT TO DO: during any call where the caller claims consent, ask\n" +
        "'WHICH website / form / offer did I fill out?' Write down the\n" +
        "answer. Then research whether that site is a known lead-generator\n" +
        "(CPA-networks like MediaAlpha, QuoteWizard, SmartFinancial, etc.)\n" +
        "and whether their consent flow would have been TCPA-compliant for\n" +
        "calls to DNC-registered numbers. Often it is not.",
    },
  ];

  return header + plays.map((p) =>
    `${p.n}. ${p.title}\n` +
    `   ${"─".repeat(Math.min(68, p.title.length))}\n` +
    p.body.split("\n").map((line) => (line ? "   " + line : "")).join("\n") + "\n"
  ).join("\n");
}

// ══════════════════════════════════════════════════════════════════════════
//  PUBLIC ENTRY POINT
// ══════════════════════════════════════════════════════════════════════════

/**
 * Build the full research report. Deterministic; no network calls.
 */
export function generateDefendantResearchReport(
  offender: OffenderProfile,
  cfg: ResearchConfig,
  caseRef: string,
  generatedAt: Date
): DefendantResearchReport {
  const score = scoreCollectability(offender, {
    userPhone: cfg?.userPhone,
    enrichment: cfg?.enrichment,
  });

  const safeCaseRef = safeString(caseRef, 100);
  const whenIso = (() => {
    try { return generatedAt.toISOString(); } catch { return new Date().toISOString(); }
  })();

  const preamble =
    "═══════════════════════════════════════════════════════════════════════\n" +
    "                    DEFENDANT RESEARCH & COLLECTABILITY\n" +
    "═══════════════════════════════════════════════════════════════════════\n" +
    `Case reference:        ${safeCaseRef}\n` +
    `Offender number:       ${safePhoneDisplay(offender?.normalizedNumber)}\n` +
    `Generated:             ${whenIso}\n` +
    `Preliminary score:     ${score.score} / 100  [${score.band}]\n` +
    "\n" +
    "PURPOSE:\n" +
    "  This document walks you through the research that MUST happen before\n" +
    "  you file your petition. Winning a TCPA case on the merits is useless\n" +
    "  if the defendant is a shell LLC, an offshore boiler room, or a spoofed\n" +
    "  caller ID with no traceable origin. Complete every checklist item\n" +
    "  below BEFORE you sign the petition's sworn verification.\n" +
    "\n" +
    "DISCLAIMER:\n" +
    "  The automated heuristics below are preliminary signals, not proof.\n" +
    "  They are computed from data in your SpamSlayer records only. The\n" +
    "  manual checklist is what actually establishes reachability. You, the\n" +
    "  plaintiff, are responsible for the accuracy of every factual claim\n" +
    "  in your petition — this report does not substitute for your own\n" +
    "  diligence.\n";

  const body =
    "\n" +
    renderExecutiveSummary(score, offender) +
    "\n" +
    renderAutomatedSignals(score) +
    "\n" +
    renderChecklist(offender, cfg) +
    "\n" +
    renderAlternatives(offender, score.band) +
    "\n" +
    "───────────────────────────────────────────────────────────────────────\n" +
    "END OF DEFENDANT RESEARCH REPORT\n" +
    "───────────────────────────────────────────────────────────────────────\n";

  return {
    text: preamble + body,
    collectability: score,
    flagAsUncollectable: score.band === "LOW",
  };
}
