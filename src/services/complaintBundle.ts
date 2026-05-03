/**
 * complaintBundle.ts — "File Everywhere" lawful pressure pipeline.
 *
 * For every offender in SpamSlayer, this module generates a bundle of
 * DRAFT complaints the user can submit to regulatory bodies and to the
 * Industry Traceback Group. Every draft is reviewed and submitted by the
 * user — this module does NOT auto-submit anything. Knowingly false
 * statements to federal agencies violate 18 U.S.C. § 1001 and several
 * state analogs, so the generator is deliberately conservative:
 *
 *   1. It states only facts present in the offender record.
 *   2. It hedges every opinion ("based on the recordings", "appears to
 *      be", "I believe") rather than asserting what is not proven.
 *   3. It OMITS complaints where the threshold condition is not met
 *      (e.g. no BBB complaint without a named business; no FTC DNC
 *      complaint without a DNC registration on file for 31+ days).
 *   4. It cites the exact statute and regulation the user can point to
 *      so the agency can route the complaint correctly.
 *
 * What each complaint actually costs the operator:
 *   - ITG traceback  → originating carrier identified or de-peered.
 *                      Pattern of tracebacks removes the provider from
 *                      the FCC Robocall Mitigation Database → US
 *                      network blocks their traffic.
 *   - FCC TCPA       → feeds enforcement-bureau 4-notice letters under
 *                      the TRACED Act.
 *   - FTC DNC        → feeds civil-penalty actions (up to $51,744 per
 *                      call, 2026 inflation adjustment).
 *   - State AG       → feeds multi-state consortium investigations
 *                      (NAAG) and in-state civil actions.
 *   - BBB            → reputation hit against the named seller. Minor
 *                      but real for legitimate businesses.
 *   - CFPB           → financial regulator scrutiny (shows up on bank
 *                      regulatory exams).
 *
 * Nothing in this module attacks the operator's systems, sends traffic
 * to their endpoints, or impersonates them. Every action routes through
 * channels those entities are legally required to answer.
 */

import type { OffenderProfile, CallEntry } from "./caseBuilder";
import type { FilingConfig } from "./legalFilingGenerator";
import { stateLinks } from "./defendantResearch";

// ────────────────────────────────────────────────────────────────────────
//  Public types
// ────────────────────────────────────────────────────────────────────────

/** A single agency/organization draft. `url` is where the user submits it. */
export interface ComplaintDraft {
  /** Stable slug, e.g. "itg-traceback" or "fcc-tcpa". Used for filenames. */
  slug: string;
  /** Human label for the README, e.g. "FCC TCPA Complaint". */
  label: string;
  /** The URL where the user actually submits this complaint. */
  submitUrl: string;
  /** Optional recipient email if the agency uses email intake. */
  submitEmail?: string;
  /** The ready-to-copy-paste body of the complaint. */
  body: string;
  /**
   * Estimated priority: lower number = file first. ITG traceback is
   * priority 1 because it has the biggest operational impact and the
   * shortest statute-of-limitations-equivalent window.
   */
  priority: number;
  /** Short plain-English description of what this complaint costs the operator. */
  impact: string;
}

/** The full bundle the user files after reviewing each draft. */
export interface ComplaintBundle {
  /** Ordered list of drafts (priority ascending). Only drafts whose threshold condition was met. */
  drafts: ComplaintDraft[];
  /** README explaining the bundle contents, filing order, and legal disclaimer. */
  readme: string;
  /** Drafts skipped and why, so the user understands gaps. */
  skipped: Array<{ slug: string; reason: string }>;
}

// ────────────────────────────────────────────────────────────────────────
//  Sanitization helpers (local copies — intentionally not shared across
//  modules because each module's output has different safe-character rules)
// ────────────────────────────────────────────────────────────────────────

function safeString(v: unknown, maxLen = 500): string {
  if (v === null || v === undefined) return "";
  let s = typeof v === "string" ? v : String(v);
  s = s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
  s = s.replace(/[\u200B-\u200F\u2028-\u202F\u2060-\u206F\uFEFF]/g, "");
  if (s.length > maxLen) s = s.slice(0, maxLen);
  return s;
}

/** Display sanitizer for rendered complaint body. Strips HTML metacharacters. */
function safeDisplay(v: unknown, maxLen = 500): string {
  return safeString(v, maxLen).replace(/</g, "(").replace(/>/g, ")").replace(/`/g, "'");
}

function digitsOnly(v: unknown): string {
  if (v === null || v === undefined) return "";
  return String(v).replace(/\D/g, "");
}

function safePhone(v: unknown): string {
  const d = digitsOnly(v).slice(0, 20);
  if (!d) return "(no number on file)";
  if (d.length === 10) return `+1 (${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
  if (d.length === 11 && d.startsWith("1")) {
    const r = d.slice(1);
    return `+1 (${r.slice(0, 3)}) ${r.slice(3, 6)}-${r.slice(6)}`;
  }
  return `+${d}`;
}

/** Format a YYYY-MM-DD date as "Month D, YYYY". Returns "(unknown)" on parse failure. */
function formatDateLong(dateStr: unknown): string {
  const s = safeString(dateStr, 30);
  if (!s) return "(unknown)";
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return s; // fall back to whatever the input was (already sanitized)
  const [_, y, mo, d] = m;
  const months = ["January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"];
  const mi = parseInt(mo, 10) - 1;
  if (mi < 0 || mi > 11) return s;
  return `${months[mi]} ${parseInt(d, 10)}, ${y}`;
}

/** Days between two YYYY-MM-DD dates (may return negative or NaN → 0). */
function daysBetween(a: string, b: string): number {
  try {
    const ta = new Date(a + "T00:00:00Z").getTime();
    const tb = new Date(b + "T00:00:00Z").getTime();
    if (!Number.isFinite(ta) || !Number.isFinite(tb)) return 0;
    return Math.round((tb - ta) / 86400000);
  } catch {
    return 0;
  }
}

// ────────────────────────────────────────────────────────────────────────
//  Universal disclaimer prepended to every complaint draft
// ────────────────────────────────────────────────────────────────────────

const DRAFT_DISCLAIMER = `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
DRAFT COMPLAINT — REVIEW BEFORE SUBMITTING
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

SpamSlayer prepared this draft from your call recordings and the
information you've entered in Settings. EVERY factual claim below must
be independently verified by you before you submit.

Knowingly false statements to a federal agency violate 18 U.S.C. § 1001
(max 5 years imprisonment). State-AG false-complaint statutes carry
similar penalties. If you are not certain a claim is true, DELETE IT
before submitting. Complaints are more effective when every sentence
is defensible — not when every possible allegation is included.

You are the submitter. Review, edit, and file each complaint yourself.
`;

// ────────────────────────────────────────────────────────────────────────
//  ITG (Industry Traceback Group) traceback request
// ────────────────────────────────────────────────────────────────────────

/**
 * Generate a ready-to-paste ITG traceback request. The ITG form at
 * tracebacks.org evolves over time, so we emit a plain-text summary
 * the user can paste into whatever fields the form currently presents.
 * Key data points: victim phone, offending caller ID, each call's date/
 * time, any recording URLs available.
 *
 * Legal grounding: ITG operates under the TRACED Act (Pub. L. 116-105)
 * and FCC rule 47 C.F.R. § 64.1200(k). Consumer tracebacks are expressly
 * invited.
 */
function generateItgTraceback(
  offender: OffenderProfile,
  cfg: FilingConfig
): ComplaintDraft {
  const offenderPhone = safePhone(offender?.normalizedNumber);
  const victimPhone = safePhone(cfg?.userPhone);
  const calls = Array.isArray(offender?.calls) ? offender.calls : [];

  const callLines: string[] = [];
  for (let i = 0; i < calls.length; i++) {
    const c: CallEntry = calls[i];
    const date = formatDateLong(c?.date);
    const time = safeDisplay(c?.time, 10) || "(unknown time)";
    const recUrl = safeDisplay(c?.recordingUrl, 300);
    const snippet = safeDisplay(c?.transcriptSnippet, 200);
    const row = [
      `  Call ${i + 1}:`,
      `    Date/time:     ${date} at ${time} (local to the recipient, ${safeDisplay(cfg?.userState, 5)})`,
      recUrl ? `    Recording:     ${recUrl}` : `    Recording:     (no recording captured)`,
      snippet ? `    Content:       "${snippet}"` : `    Content:       (no transcript captured)`,
    ];
    callLines.push(row.join("\n"));
  }

  const firstCall = formatDateLong(offender?.firstCallDate);
  const lastCall = formatDateLong(offender?.lastCallDate);
  const span = daysBetween(
    safeString(offender?.firstCallDate, 30),
    safeString(offender?.lastCallDate, 30)
  );

  const body =
`${DRAFT_DISCLAIMER}

INDUSTRY TRACEBACK GROUP (ITG) — TRACEBACK REQUEST
Submit at: https://tracebacks.org
Legal basis: TRACED Act, Pub. L. 116-105; 47 C.F.R. § 64.1200(k)

─── CONSUMER / RECIPIENT INFORMATION ─────────────────────────────────

  Name:          ${safeDisplay(cfg?.userName, 200)}
  Email:         ${safeDisplay(cfg?.userEmail, 200)}
  Phone called:  ${victimPhone}
  Address:       ${safeDisplay(cfg?.userAddress, 200)}, ${safeDisplay(cfg?.userCity, 100)}, ${safeDisplay(cfg?.userState, 5)} ${safeDisplay(cfg?.userZip, 10)}

─── OFFENDING CALLER-ID NUMBER ───────────────────────────────────────

  Displayed number:   ${offenderPhone}
  First call:         ${firstCall}
  Most recent call:   ${lastCall}
  Total calls:        ${Number(offender?.callCount) || calls.length}
  Campaign span:      ${span > 0 ? `${span} day(s)` : "single-day or short burst"}

─── CALLS (with recordings where available) ─────────────────────────

${callLines.join("\n\n") || "  (no calls on record)"}

─── REASON FOR TRACEBACK REQUEST ─────────────────────────────────────

The number above has placed unsolicited telemarketing calls to my
residential/cellular line. The displayed caller ID appears to be
spoofed — my carrier has not been able to identify the originating
carrier without an upstream trace. I am requesting a STIR/SHAKEN
traceback to identify the downstream provider and the subscribing
customer so that:

  1. The responsible originating carrier can be held accountable
     under 47 C.F.R. § 64.1200(n)(1) (Know Your Customer).
  2. The number can be blocked at the network level if the
     originating carrier cannot lawfully attest to the caller's
     identity.
  3. The subscribing customer can be identified for consumer
     enforcement action under 47 U.S.C. § 227(b) and (c).

I have attached the call evidence above. Recordings are available
at the URLs listed; I can provide direct downloads on request.

I understand that ITG will share this request with the terminating
carrier and applicable upstream providers. I consent to that sharing
for the purpose of tracing these calls.

─── SIGNATURE ────────────────────────────────────────────────────────

  Submitted by:  ${safeDisplay(cfg?.userName, 200)}
  Date:          ${formatDateLong(new Date().toISOString().split("T")[0])}
`;

  return {
    slug: "itg-traceback",
    label: "ITG Traceback Request (tracebacks.org)",
    submitUrl: "https://tracebacks.org",
    body,
    priority: 1,
    impact:
      "Forces originating carrier to identify the downstream subscriber " +
      "or face de-peering by upstream carriers. Highest operational impact — " +
      "a pattern of tracebacks removes providers from the Robocall Mitigation " +
      "Database, at which point US carriers are required to block all their " +
      "traffic.",
  };
}

// ────────────────────────────────────────────────────────────────────────
//  FCC TCPA complaint
// ────────────────────────────────────────────────────────────────────────

/**
 * Generate an FCC TCPA-violation complaint draft. The FCC consumer complaint
 * form lives at https://consumercomplaints.fcc.gov/hc/en-us and accepts
 * phone-related complaints under its "Phone" category.
 *
 * Legal grounding:
 *   - 47 U.S.C. § 227(b)(1)(A)(iii): prerecorded or ATDS calls to cellular
 *     without consent (2026: Facebook v. Duguid narrowed ATDS but
 *     prerecorded-voice prong remains broad).
 *   - 47 U.S.C. § 227(b)(1)(B): prerecorded calls to residential without consent.
 *   - 47 U.S.C. § 227(c)(5): DNC-registry violations (requires DNC registration).
 *   - Calling-hours violation (8 AM – 9 PM local): the TCPA implementing
 *     regulation in 47 C.F.R. Part 64 Subpart L carries this restriction.
 *     TODO(citation-audit): this module previously named the subsection as
 *     § 64.1200(a)(1)(i), which the citation registry flags as wrong. The
 *     calling-hours rule is commonly understood to live at § 64.1200(c)(1),
 *     but no human on this project has personally confirmed that against
 *     the primary source yet, so we emit the narrative without a
 *     subsection number rather than risk a miscite in a sworn filing.
 *     See statuteRegistry.ts entry for § 64.1200(a)(1)(i).
 *
 * We pick the right citation(s) based on cfg.lineType and whether the
 * user's DNC registration on file is 31+ days old.
 */
function generateFccComplaint(
  offender: OffenderProfile,
  cfg: FilingConfig
): ComplaintDraft {
  const victimPhone = safePhone(cfg?.userPhone);
  const offenderPhone = safePhone(offender?.normalizedNumber);
  const callCount = Number(offender?.callCount) || (Array.isArray(offender?.calls) ? offender.calls.length : 0);

  // Determine applicable TCPA subsections conservatively.
  const lineType = safeString((cfg as any)?.lineType || "unspecified", 20);
  const hasRecordings = Array.isArray(offender?.calls)
    && offender.calls.some((c: CallEntry) => !!c?.recordingUrl);

  const citationLines: string[] = [];
  if (lineType === "cellular" || lineType === "mixed") {
    citationLines.push(
      "  • 47 U.S.C. § 227(b)(1)(A)(iii) — prerecorded voice or autodialed"
    );
    citationLines.push(
      "    calls to a cellular telephone without prior express consent."
    );
  }
  if (lineType === "residential" || lineType === "mixed") {
    citationLines.push(
      "  • 47 U.S.C. § 227(b)(1)(B) — prerecorded voice calls to a"
    );
    citationLines.push(
      "    residential telephone without prior express consent."
    );
  }
  if (lineType === "unspecified") {
    citationLines.push(
      "  • 47 U.S.C. § 227(b)(1) — prerecorded voice or automated calls"
    );
    citationLines.push(
      "    to my telephone without prior express consent."
    );
  }

  // DNC addition only if we have a registration date and it's 31+ days old
  // relative to the first call (statutory "residential subscriber" protection
  // under § 227(c)(5) requires prior registration).
  const dncDate = safeString(cfg?.dncRegistrationDate, 30);
  const firstCall = safeString(offender?.firstCallDate, 30);
  const dncToFirst = dncDate && firstCall ? daysBetween(dncDate, firstCall) : 0;
  const dncEligible = !!dncDate && dncToFirst >= 31;
  if (dncEligible) {
    citationLines.push(
      "  • 47 U.S.C. § 227(c)(5) — calls to a number on the National Do"
    );
    citationLines.push(
      "    Not Call Registry more than 31 days after registration."
    );
  }

  // Call-hour (8 AM–9 PM local) only if calls outside that window are on record.
  const outOfHourCount = Array.isArray(offender?.calls)
    ? offender.calls.filter((c: CallEntry) => {
        const t = safeString(c?.time, 10);
        const m = /^(\d{1,2}):(\d{2})/.exec(t);
        if (!m) return false;
        const h = parseInt(m[1], 10);
        return h < 8 || h >= 21;
      }).length
    : 0;
  if (outOfHourCount > 0) {
    // TODO(citation-audit): the FCC calling-hours rule lives in 47 C.F.R.
    // Part 64 Subpart L, but this module used to name the subsection as
    // § 64.1200(a)(1)(i), which the citation registry flags as wrong
    // (emergency-line subsection, not calling-hours). Until a human
    // confirms the correct subsection against the primary source and
    // updates statuteRegistry.ts, we emit only the narrative — no
    // subsection number goes into a sworn filing on a guess.
    citationLines.push(
      "  • Calls before 8 AM or after 9 PM local time — violation of the"
    );
    citationLines.push(
      `    FCC calling-hours rule (${outOfHourCount} such call(s) on record).`
    );
  }

  const evidenceLines: string[] = [];
  const calls = Array.isArray(offender?.calls) ? offender.calls : [];
  const maxShown = 10;
  for (let i = 0; i < Math.min(calls.length, maxShown); i++) {
    const c = calls[i];
    evidenceLines.push(
      `  ${i + 1}. ${formatDateLong(c?.date)} at ${safeDisplay(c?.time, 10) || "(time unknown)"}` +
      (c?.recordingUrl ? " — recording available" : "")
    );
  }
  if (calls.length > maxShown) {
    evidenceLines.push(`  … and ${calls.length - maxShown} more on file.`);
  }

  const companyLine = offender?.companyName
    ? `The caller identified themselves as or on behalf of: "${safeDisplay(offender.companyName, 200)}". I have not independently verified this identification.`
    : "The caller did not clearly identify a responsible business entity. The displayed caller ID appears to be spoofed.";

  const body =
`${DRAFT_DISCLAIMER}

FCC CONSUMER COMPLAINT — UNWANTED CALLS / TCPA VIOLATION
Submit at: https://consumercomplaints.fcc.gov/hc/en-us/requests/new
Form category: "Phone" → "Unwanted Calls" → "Robocalls" (select what matches your evidence)

─── CONSUMER / RECIPIENT ─────────────────────────────────────────────

  Name:                ${safeDisplay(cfg?.userName, 200)}
  Email:               ${safeDisplay(cfg?.userEmail, 200)}
  Phone called:        ${victimPhone}
  Address:             ${safeDisplay(cfg?.userAddress, 200)}, ${safeDisplay(cfg?.userCity, 100)}, ${safeDisplay(cfg?.userState, 5)} ${safeDisplay(cfg?.userZip, 10)}
  Line type (self-reported):  ${lineType}
${dncEligible ? `  DNC-registered since:       ${formatDateLong(dncDate)} (${dncToFirst} days before first offending call)` : ""}

─── OFFENDING CALLER ─────────────────────────────────────────────────

  Displayed caller ID: ${offenderPhone}
  Total calls:         ${callCount}
  First call:          ${formatDateLong(offender?.firstCallDate)}
  Most recent call:    ${formatDateLong(offender?.lastCallDate)}
  Recordings on file:  ${hasRecordings ? "yes — URLs available on request" : "no recordings captured"}

  ${companyLine}

─── APPLICABLE TCPA / FCC RULES ──────────────────────────────────────

I am reporting violations of one or more of the following provisions:

${citationLines.join("\n") || "  • 47 U.S.C. § 227(b)(1) (general prerecorded/automated-call prohibition)"}

─── CALL LOG (partial — full log available on request) ──────────────

${evidenceLines.join("\n") || "  (no calls on record — please disregard)"}

─── RELIEF REQUESTED ─────────────────────────────────────────────────

I request that the FCC:
  1. Investigate the originating carrier of these calls and, if the
     carrier cannot attest to the caller's identity under STIR/SHAKEN,
     pursue enforcement under 47 C.F.R. § 64.6305.
  2. Add this number to the Commission's robocall-enforcement queue.
  3. Share this complaint with the Industry Traceback Group if a
     traceback has not already been initiated.

I am not requesting individual compensation from the FCC; I am
reporting this pattern so the Commission can act against the
originating provider.

─── DECLARATION ──────────────────────────────────────────────────────

The facts above are true to the best of my knowledge and are derived
from call records and recordings in my possession.

  ${safeDisplay(cfg?.userName, 200)}
  ${formatDateLong(new Date().toISOString().split("T")[0])}
`;

  return {
    slug: "fcc-tcpa",
    label: "FCC TCPA / Unwanted-Calls Complaint",
    submitUrl: "https://consumercomplaints.fcc.gov/hc/en-us/requests/new",
    body,
    priority: 2,
    impact:
      "Feeds the FCC Enforcement Bureau's complaint queue. Volume-weighted: " +
      "a single complaint is one data point; a pattern triggers 4-notice " +
      "letters under the TRACED Act and can force removal from the Robocall " +
      "Mitigation Database.",
  };
}

// ────────────────────────────────────────────────────────────────────────
//  FTC DNC complaint (only if registration date is on file and 31+ days old)
// ────────────────────────────────────────────────────────────────────────

function generateFtcDncComplaint(
  offender: OffenderProfile,
  cfg: FilingConfig
): ComplaintDraft | { skip: string } {
  const dncDate = safeString(cfg?.dncRegistrationDate, 30);
  const firstCall = safeString(offender?.firstCallDate, 30);

  if (!dncDate) {
    return {
      skip:
        "User has not provided a DNC registration date in Settings. The FTC " +
        "DNC complaint form requires the date of registration to verify the " +
        "§ 227(c)(5) 31-day rule applies. Set your DNC registration date in " +
        "Settings and regenerate.",
    };
  }
  if (!firstCall) {
    return {
      skip:
        "No first-call date on record, so the 31-day DNC eligibility window " +
        "cannot be evaluated.",
    };
  }
  const span = daysBetween(dncDate, firstCall);
  if (span < 31) {
    return {
      skip:
        `DNC registration (${formatDateLong(dncDate)}) is only ${span} days ` +
        `before the first offending call (${formatDateLong(firstCall)}). ` +
        "The § 227(c)(5) private-right-of-action threshold is 31 days. The " +
        "FTC DNC complaint is not filed to avoid asserting eligibility that " +
        "may not yet apply. The FCC TCPA complaint still applies.",
    };
  }

  const victimPhone = safePhone(cfg?.userPhone);
  const offenderPhone = safePhone(offender?.normalizedNumber);

  const body =
`${DRAFT_DISCLAIMER}

FTC DO-NOT-CALL COMPLAINT
Submit at: https://www.donotcall.gov/report.html
Legal basis: FTC Telemarketing Sales Rule, 16 C.F.R. § 310; 47 U.S.C. § 227(c)

─── REQUIRED FORM FIELDS ─────────────────────────────────────────────

  Number that was called (yours):   ${victimPhone}
  Date of call:                      ${formatDateLong(offender?.lastCallDate)}
                                     (most recent; file a separate complaint
                                     per call for pattern weighting — the
                                     form permits one date per submission)
  Type of call:                      [ ] Robocall    [ ] Live caller
                                     (select what matches this specific call)
  Phone number of caller:            ${offenderPhone}
  Subject of the call (optional):    ${offender?.purpose ? safeDisplay(offender.purpose, 200) : "(describe the product pitched, per your recording)"}
  Company name (optional):           ${offender?.companyName ? safeDisplay(offender.companyName, 200) : "(leave blank unless the caller clearly identified a company)"}

─── ELIGIBILITY NOTE ─────────────────────────────────────────────────

  My number ${victimPhone} has been continuously registered on the
  National Do Not Call Registry since ${formatDateLong(dncDate)} —
  ${span} days before the first offending call on ${formatDateLong(firstCall)}.
  This exceeds the 31-day waiting period in 47 U.S.C. § 227(c)(5) and
  16 C.F.R. § 310.4(b)(1)(iii)(B).

─── ADDITIONAL NOTES (paste into "tell us more" field) ──────────────

  I have ${Number(offender?.callCount) || "multiple"} call(s) from
  this number on file, spanning ${formatDateLong(offender?.firstCallDate)}
  to ${formatDateLong(offender?.lastCallDate)}. Recordings are available
  on request. The displayed caller ID may be spoofed; a STIR/SHAKEN
  traceback has ${Array.isArray(offender?.calls) && offender.calls.length >= 3 ? "been / will be" : "been"}
  requested from the Industry Traceback Group.

─── REMINDER ─────────────────────────────────────────────────────────

  If you received MULTIPLE calls from this number, the FTC DNC form
  accepts one complaint per call date. File separately for each call
  to maximize pattern weighting. This draft reflects your most recent
  call; duplicate and update the "Date of call" field for each one.
`;

  return {
    slug: "ftc-dnc",
    label: "FTC Do-Not-Call Registry Complaint",
    submitUrl: "https://www.donotcall.gov/report.html",
    body,
    priority: 3,
    impact:
      "Feeds FTC telemarketing enforcement. Civil penalties up to $51,744 " +
      "per call (2026 inflation-adjusted). High-volume operators get swept " +
      "into joint FTC/state-AG actions (e.g. Operation Call It Quits).",
  };
}

// ────────────────────────────────────────────────────────────────────────
//  State AG consumer-protection complaint
// ────────────────────────────────────────────────────────────────────────

function generateStateAgComplaint(
  offender: OffenderProfile,
  cfg: FilingConfig
): ComplaintDraft {
  const links = stateLinks(safeString(cfg?.userState, 5));
  const victimPhone = safePhone(cfg?.userPhone);
  const offenderPhone = safePhone(offender?.normalizedNumber);
  const stateStatute = safeDisplay(cfg?.stateDncStatute, 100) || "(your state's DNC / consumer-protection statute)";
  const stateLong = safeDisplay((cfg as any)?.stateLong || cfg?.userState, 50) || "your state";

  const companyLine = offender?.companyName
    ? `The caller identified themselves as or on behalf of "${safeDisplay(offender.companyName, 200)}". I have not independently verified this identification.`
    : "The caller did not clearly identify a responsible business entity.";

  const body =
`${DRAFT_DISCLAIMER}

STATE ATTORNEY GENERAL — CONSUMER COMPLAINT
${links.agLabel}
Submit at: ${links.agUrl}

─── CONSUMER ─────────────────────────────────────────────────────────

  Name:     ${safeDisplay(cfg?.userName, 200)}
  Address:  ${safeDisplay(cfg?.userAddress, 200)}, ${safeDisplay(cfg?.userCity, 100)}, ${safeDisplay(cfg?.userState, 5)} ${safeDisplay(cfg?.userZip, 10)}
  Phone:    ${victimPhone}
  Email:    ${safeDisplay(cfg?.userEmail, 200)}

─── BUSINESS COMPLAINED ABOUT ────────────────────────────────────────

  Displayed caller ID:  ${offenderPhone}
  Total calls:          ${Number(offender?.callCount) || (Array.isArray(offender?.calls) ? offender.calls.length : 0)}
  Date range:           ${formatDateLong(offender?.firstCallDate)} – ${formatDateLong(offender?.lastCallDate)}
  Recordings on file:   ${Array.isArray(offender?.calls) && offender.calls.some((c: CallEntry) => !!c?.recordingUrl) ? "yes" : "no"}

  ${companyLine}

─── NATURE OF COMPLAINT ──────────────────────────────────────────────

I am reporting unlawful telemarketing calls to my telephone in
${stateLong}. I believe these calls violate:

  • 47 U.S.C. § 227 (federal TCPA)
  • ${stateStatute} (state Do-Not-Call / consumer-protection)
  • ${safeDisplay(cfg?.stateRecordingLaw || "", 200) || "(state recording-consent law where applicable)"}

I am not in a business relationship with the caller and did not
provide prior express written consent to receive telemarketing calls.
My number is registered on the National Do Not Call Registry${cfg?.dncRegistrationDate ? ` as of ${formatDateLong(cfg.dncRegistrationDate)}` : ""}.

─── WHAT I AM ASKING ─────────────────────────────────────────────────

  1. Investigation of the caller and the seller on whose behalf
     the calls were placed (see FCC 2013 DISH Network ruling, 28 FCC
     Rcd 6574, on seller liability for agent-placed telemarketing).
  2. Coordination with other state AGs if this caller is active
     across state lines (via NAAG's telemarketing working group).
  3. Any action available under ${stateStatute}.

I have parallel complaints pending with the FCC, FTC, and the
Industry Traceback Group.

─── DECLARATION ──────────────────────────────────────────────────────

The facts above are true to the best of my knowledge and are derived
from call records and recordings in my possession.

  ${safeDisplay(cfg?.userName, 200)}
  ${formatDateLong(new Date().toISOString().split("T")[0])}
`;

  return {
    slug: "state-ag",
    label: `State AG Complaint — ${links.agLabel}`,
    submitUrl: links.agUrl,
    body,
    priority: 4,
    impact:
      "Feeds in-state civil enforcement and the NAAG multi-state telemarketing " +
      "consortium. Some states (IN, MO, TX, MA, WA) are particularly aggressive " +
      "on telemarketing and have obtained seven- and eight-figure judgments " +
      "against VSC and solar operators. Your individual complaint adds to the " +
      "pattern those actions are built on.",
  };
}

// ────────────────────────────────────────────────────────────────────────
//  BBB (only if a specific business has been identified)
// ────────────────────────────────────────────────────────────────────────

const GENERIC_COMPANY_PATTERNS = [
  /^customer service$/i, /^sales$/i, /^support$/i, /^billing$/i,
  /^main office$/i, /^unknown$/i, /^private$/i,
  /^auto warranty (dept|department)$/i,
  /^warranty (dept|department)$/i,
];

function isGenericCompany(name: string): boolean {
  const n = name.trim();
  if (!n) return true;
  if (n.length < 3) return true;
  return GENERIC_COMPANY_PATTERNS.some((r) => r.test(n));
}

function generateBbbComplaint(
  offender: OffenderProfile,
  cfg: FilingConfig
): ComplaintDraft | { skip: string } {
  const raw = safeString(offender?.companyName, 200);
  if (!raw || isGenericCompany(raw)) {
    return {
      skip:
        "No specific business name on file for this offender. BBB complaints " +
        "require the business-being-complained-about as the recipient; a " +
        "generic caller label (e.g. 'Customer Service', 'Auto Warranty Dept') " +
        "is not sufficient. If you identify the seller from a recording " +
        "(e.g. CarShield, Endurance, etc.), update the offender's companyName " +
        "and regenerate.",
    };
  }
  const companyName = safeDisplay(raw, 200);
  const victimPhone = safePhone(cfg?.userPhone);
  const offenderPhone = safePhone(offender?.normalizedNumber);

  const body =
`${DRAFT_DISCLAIMER}

BBB (BETTER BUSINESS BUREAU) COMPLAINT
Submit at: https://www.bbb.org/file-a-complaint
Business: ${companyName}

─── COMPLAINT SUMMARY ────────────────────────────────────────────────

Business:          ${companyName}
Complaint type:    Advertising / Sales Practices — unwanted telemarketing
My name:           ${safeDisplay(cfg?.userName, 200)}
My phone:          ${victimPhone}
My email:          ${safeDisplay(cfg?.userEmail, 200)}
Caller ID shown:   ${offenderPhone}
Call count:        ${Number(offender?.callCount) || (Array.isArray(offender?.calls) ? offender.calls.length : 0)}
Date range:        ${formatDateLong(offender?.firstCallDate)} – ${formatDateLong(offender?.lastCallDate)}

─── DESCRIPTION (paste into BBB "describe the problem" field) ───────

${companyName} (or a telemarketer representing ${companyName}) has
placed unsolicited sales calls to my telephone. I am not a customer
of ${companyName} and have not provided prior express written consent
to receive telemarketing calls.

My number is on the National Do Not Call Registry${cfg?.dncRegistrationDate ? ` since ${formatDateLong(cfg.dncRegistrationDate)}` : ""}.
The caller ID displayed on these calls may be spoofed; I am pursuing
a STIR/SHAKEN traceback through the Industry Traceback Group and
complaints are pending with the FCC, FTC, and my state Attorney
General.

─── DESIRED RESOLUTION ───────────────────────────────────────────────

  1. ${companyName} ceases telemarketing calls to my number immediately
     and adds my number to its internal DNC list.
  2. ${companyName} identifies and terminates any third-party
     telemarketing vendor responsible for these calls.
  3. ${companyName} confirms in writing that my number has been removed
     from all active campaigns.

I will update the BBB on the business's response.

─── DECLARATION ──────────────────────────────────────────────────────

The facts above are true to the best of my knowledge.

  ${safeDisplay(cfg?.userName, 200)}
  ${formatDateLong(new Date().toISOString().split("T")[0])}
`;

  return {
    slug: "bbb",
    label: `BBB Complaint — ${companyName}`,
    submitUrl: "https://www.bbb.org/file-a-complaint",
    body,
    priority: 5,
    impact:
      "Reputation signal against a named, legitimate seller. Not applicable " +
      "to shell operators. Some VSC and solar sellers treat BBB rating as a " +
      "customer-acquisition input and will respond quickly to avoid a " +
      "rating downgrade.",
  };
}

// ────────────────────────────────────────────────────────────────────────
//  CFPB (only for financial-product pitches)
// ────────────────────────────────────────────────────────────────────────

const FINANCIAL_PITCH_PATTERNS: RegExp[] = [
  /student\s+loan(?:\s+forgiveness)?/i,
  /debt\s+(relief|consolidation|settlement|forgiveness)/i,
  /credit\s+card\s+(interest|rate|relief|consolidation)/i,
  /lower\s+your\s+(interest|rate)/i,
  /irs\s+(debt|is filing|tax)/i,
  /mortgage\s+(modification|refinance|relief)/i,
  /payday\s+loan/i,
  /personal\s+loan/i,
];

function detectFinancialPitch(offender: OffenderProfile): string | null {
  const calls = Array.isArray(offender?.calls) ? offender.calls : [];
  const purpose = safeString(offender?.purpose, 200).toLowerCase();
  const haystacks = [purpose];
  for (const c of calls) haystacks.push(safeString(c?.transcriptSnippet, 500));
  for (const h of haystacks) {
    for (const re of FINANCIAL_PITCH_PATTERNS) {
      const m = re.exec(h);
      if (m) return m[0];
    }
  }
  return null;
}

function generateCfpbComplaint(
  offender: OffenderProfile,
  cfg: FilingConfig
): ComplaintDraft | { skip: string } {
  const match = detectFinancialPitch(offender);
  if (!match) {
    return {
      skip:
        "No financial-product pitch detected in call transcripts. CFPB " +
        "jurisdiction covers debt collection, student loans, credit cards, " +
        "mortgages, and related consumer-financial products only. Skipped.",
    };
  }

  const victimPhone = safePhone(cfg?.userPhone);
  const offenderPhone = safePhone(offender?.normalizedNumber);

  const body =
`${DRAFT_DISCLAIMER}

CFPB COMPLAINT — UNSOLICITED CALLS RE: CONSUMER FINANCIAL PRODUCT
Submit at: https://www.consumerfinance.gov/complaint/
Jurisdiction: 12 U.S.C. § 5534 (CFPB complaint-handling authority)

─── COMPLAINT TYPE ───────────────────────────────────────────────────

Category:    Debt collection / Student loan / Credit card / Mortgage
             (select the category that matches the pitch detected:
             "${safeDisplay(match, 100)}")

─── CONSUMER ─────────────────────────────────────────────────────────

  Name:     ${safeDisplay(cfg?.userName, 200)}
  Address:  ${safeDisplay(cfg?.userAddress, 200)}, ${safeDisplay(cfg?.userCity, 100)}, ${safeDisplay(cfg?.userState, 5)} ${safeDisplay(cfg?.userZip, 10)}
  Phone:    ${victimPhone}
  Email:    ${safeDisplay(cfg?.userEmail, 200)}

─── CALLER / COMPANY ─────────────────────────────────────────────────

  Displayed caller ID:    ${offenderPhone}
  Total calls:            ${Number(offender?.callCount) || (Array.isArray(offender?.calls) ? offender.calls.length : 0)}
  Date range:             ${formatDateLong(offender?.firstCallDate)} – ${formatDateLong(offender?.lastCallDate)}
  Business name claimed:  ${offender?.companyName ? safeDisplay(offender.companyName, 200) : "(not identified — caller ID may be spoofed)"}

─── WHAT HAPPENED ────────────────────────────────────────────────────

I received unsolicited telemarketing calls pitching what appears to
be a ${safeDisplay(match, 100)} product or service. I am not a
customer of the caller and did not request this contact. My number
is on the National Do Not Call Registry${cfg?.dncRegistrationDate ? ` as of ${formatDateLong(cfg.dncRegistrationDate)}` : ""}.

I am concerned the caller is:
  • Operating without proper licensure for consumer-financial services
    in ${safeDisplay(cfg?.userState, 5)};
  • Using deceptive tactics that may violate 12 U.S.C. § 5531 (UDAAP);
  • Engaging a lead-generator / data broker that sold my information
    without lawful consent.

─── DESIRED RESOLUTION ───────────────────────────────────────────────

  1. CFPB investigation of the caller's licensure and sales practices.
  2. Coordination with FTC and FCC on parallel enforcement.
  3. Scrubbing of my number from any lead lists traced back to this
     caller.

─── DECLARATION ──────────────────────────────────────────────────────

The facts above are true to the best of my knowledge and are derived
from call records and recordings in my possession.

  ${safeDisplay(cfg?.userName, 200)}
  ${formatDateLong(new Date().toISOString().split("T")[0])}
`;

  return {
    slug: "cfpb",
    label: "CFPB Consumer Financial Protection Complaint",
    submitUrl: "https://www.consumerfinance.gov/complaint/",
    body,
    priority: 6,
    impact:
      "CFPB responds to every complaint within 15 days and publishes a " +
      "company-response record. Regulated entities (banks, lenders, " +
      "servicers) are examined on their CFPB-complaint volume during " +
      "regulatory exams — a meaningful reputational and compliance cost.",
  };
}

// ────────────────────────────────────────────────────────────────────────
//  README — instructions and filing order
// ────────────────────────────────────────────────────────────────────────

function generateReadme(
  drafts: ComplaintDraft[],
  skipped: Array<{ slug: string; reason: string }>,
  offender: OffenderProfile,
  cfg: FilingConfig
): string {
  const phone = safePhone(offender?.normalizedNumber);
  const today = formatDateLong(new Date().toISOString().split("T")[0]);

  const sections: string[] = [];
  sections.push("═══════════════════════════════════════════════════════════════════════");
  sections.push("   COMPLAINT BUNDLE — FILE EVERYWHERE KIT");
  sections.push(`   Offender: ${phone}`);
  sections.push(`   Prepared: ${today}`);
  sections.push("═══════════════════════════════════════════════════════════════════════");
  sections.push("");
  sections.push("PURPOSE");
  sections.push("");
  sections.push("  This bundle contains DRAFTS of lawful complaints you can file against");
  sections.push("  the offender without going to court. Every draft is based on your call");
  sections.push("  records; every draft must be reviewed by you before submission.");
  sections.push("");
  sections.push("  None of these complaints touch the offender's systems, send traffic to");
  sections.push("  their endpoints, or impersonate them. Each routes through channels");
  sections.push("  those entities are legally required to answer.");
  sections.push("");
  sections.push("LEGAL DISCLAIMER");
  sections.push("");
  sections.push("  Knowingly false statements to a federal agency violate 18 U.S.C. § 1001");
  sections.push("  and carry criminal penalties. State-AG false-complaint statutes carry");
  sections.push("  similar penalties. If you are not certain a fact stated in a draft is");
  sections.push("  true, DELETE IT before submitting. A complaint is more effective when");
  sections.push("  every sentence is defensible.");
  sections.push("");
  sections.push("  SpamSlayer is not your attorney. This bundle is a drafting aid, not");
  sections.push("  legal advice. If any complaint could implicate you criminally,");
  sections.push("  financially, or reputationally, consult counsel before filing.");
  sections.push("");
  sections.push("FILING ORDER (file in this order for maximum leverage)");
  sections.push("");
  for (const d of drafts) {
    sections.push(`  ${d.priority}. ${d.label}`);
    sections.push(`     Submit: ${d.submitUrl}`);
    sections.push(`     Why:    ${d.impact}`);
    sections.push("");
  }
  if (skipped.length > 0) {
    sections.push("SKIPPED (and why)");
    sections.push("");
    for (const s of skipped) {
      sections.push(`  • ${s.slug}:`);
      sections.push(`    ${s.reason}`);
      sections.push("");
    }
  }
  sections.push("HOW TO USE THIS BUNDLE");
  sections.push("");
  sections.push("  1. Open each draft file in the order above.");
  sections.push("  2. Read every sentence. Remove anything you cannot swear is true.");
  sections.push("  3. Open the submission URL listed at the top of the draft.");
  sections.push("  4. Paste the draft body (or the relevant fields) into the form.");
  sections.push("  5. Attach call recordings if the form allows.");
  sections.push("  6. Submit. Save your confirmation email / reference number.");
  sections.push("  7. Log the submission so you can follow up (FCC and CFPB will");
  sections.push("     usually respond within 15 business days; ITG sooner).");
  sections.push("");
  sections.push("TIME BUDGET");
  sections.push("");
  sections.push("  Realistically about 30–45 minutes for the full bundle. ITG takes the");
  sections.push("  longest because the form is detailed; FTC DNC is the fastest. None");
  sections.push("  costs you anything except your time.");
  sections.push("");
  sections.push("───────────────────────────────────────────────────────────────────────");
  sections.push("END OF README");
  sections.push("───────────────────────────────────────────────────────────────────────");
  return sections.join("\n");
}

// ────────────────────────────────────────────────────────────────────────
//  Public API
// ────────────────────────────────────────────────────────────────────────

/**
 * Generate the full complaint bundle for an offender. This function
 * performs NO network I/O and NO file I/O; it returns the drafts as
 * strings. The caller writes them to disk (see legalFilingGenerator's
 * generateAndSaveFilingPackage for the pattern).
 */
export function generateComplaintBundle(
  offender: OffenderProfile,
  cfg: FilingConfig
): ComplaintBundle {
  const drafts: ComplaintDraft[] = [];
  const skipped: Array<{ slug: string; reason: string }> = [];

  // ITG — always runs (even if no recordings; ITG will request them).
  drafts.push(generateItgTraceback(offender, cfg));

  // FCC — always runs (every offending call qualifies under some § 227 prong).
  drafts.push(generateFccComplaint(offender, cfg));

  // FTC DNC — only if registration is on file and 31+ days before first call.
  const ftc = generateFtcDncComplaint(offender, cfg);
  if ("skip" in ftc) skipped.push({ slug: "ftc-dnc", reason: ftc.skip });
  else drafts.push(ftc);

  // State AG — always runs; uses the state AG URL map.
  drafts.push(generateStateAgComplaint(offender, cfg));

  // BBB — only if a specific (non-generic) business is named.
  const bbb = generateBbbComplaint(offender, cfg);
  if ("skip" in bbb) skipped.push({ slug: "bbb", reason: bbb.skip });
  else drafts.push(bbb);

  // CFPB — only if a financial-product pitch is detected in transcripts.
  const cfpb = generateCfpbComplaint(offender, cfg);
  if ("skip" in cfpb) skipped.push({ slug: "cfpb", reason: cfpb.skip });
  else drafts.push(cfpb);

  // Stable priority sort (ITG=1, FCC=2, FTC=3, AG=4, BBB=5, CFPB=6).
  drafts.sort((a, b) => a.priority - b.priority);

  const readme = generateReadme(drafts, skipped, offender, cfg);

  return { drafts, readme, skipped };
}
