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
//  - Louisiana-specific: La. R.S. 45:844.14, La. R.S. 15:1303, La. C.C.P. Art. 4910+
// ─────────────────────────────────────────────────────────────────────────────

import { OffenderProfile, CallEntry, getOffender } from "./caseBuilder";
import fs from "fs";
import path from "path";

// ── Filing config (loaded from phone.json or defaults) ──────────────────

const PHONE_CONFIG_PATH = path.resolve(process.cwd(), "phone.json");

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
  smallClaimsStatute: string;     // e.g. "La. C.C.P. Art. 4910 et seq."
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
  smallClaimsStatute: "La. C.C.P. Art. 4910 et seq.",
};

function loadFilingConfig(): FilingConfig {
  let config: FilingConfig;

  try {
    const raw = JSON.parse(fs.readFileSync(PHONE_CONFIG_PATH, "utf-8"));
    config = { ...DEFAULT_FILING_CONFIG, ...(raw.filingConfig ?? {}) };
  } catch {
    console.warn("[LegalFiling] phone.json not found or invalid, using defaults");
    config = DEFAULT_FILING_CONFIG;
  }

  return config;
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
}

// ── Types for the filing package ────────────────────────────────────────

export interface FilingPackage {
  petition: string;
  exhibitList: string;
  certificateOfService: string;
  filingGuide: string;
  caseNumber: string;         // internal reference, not court-assigned
  generatedDate: string;
  offenderNumber: string;
  damagesRequested: number;
  warnings: string[];         // any legal warnings (SOL, etc.)
}

// ── Internal helpers ────────────────────────────────────────────────────

function formatDate(dateStr: string): string {
  try {
    const d = new Date(dateStr + "T00:00:00");
    return d.toLocaleDateString("en-US", {
      year: "numeric",
      month: "long",
      day: "numeric",
    });
  } catch {
    return dateStr;
  }
}

function generateCaseRef(offender: OffenderProfile): string {
  const datePart = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const phonePart = offender.normalizedNumber.slice(-4);
  return `SS-${datePart}-${phonePart}`;
}

/**
 * Generate exhibit labels: A, B, ... Z, AA, AB, ... AZ, BA, ...
 * Handles any number of exhibits without crashing.
 */
function createExhibitLabeler(): () => string {
  let index = 0;
  return () => {
    let label = "";
    let n = index;
    if (n < 26) {
      label = String.fromCharCode(65 + n);
    } else {
      // AA, AB, ... AZ, BA, BB, ...
      const first = String.fromCharCode(65 + Math.floor((n - 26) / 26));
      const second = String.fromCharCode(65 + (n % 26));
      label = first + second;
    }
    index++;
    return label;
  };
}

/**
 * Sanitize transcript text to redact PII before including in court filings.
 * Removes SSNs, credit card numbers, and other sensitive patterns.
 */
function sanitizeTranscript(text: string): string {
  let sanitized = text;
  // SSN pattern: XXX-XX-XXXX or XXXXXXXXX
  sanitized = sanitized.replace(/\b\d{3}-\d{2}-\d{4}\b/g, "[SSN REDACTED]");
  sanitized = sanitized.replace(/\b\d{9}\b/g, "[POSSIBLE SSN REDACTED]");
  // Credit card: 16 digits with optional separators
  sanitized = sanitized.replace(/\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g, "[CC# REDACTED]");
  // Bank account / routing (8-17 digit sequences)
  sanitized = sanitized.replace(/\b\d{8,17}\b/g, "[ACCOUNT# REDACTED]");
  return sanitized;
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
 * Check statute of limitations. TCPA has a 4-year federal SOL.
 * Returns a warning string if any calls are approaching or past the deadline.
 */
function checkStatuteOfLimitations(offender: OffenderProfile): string | null {
  const SOL_YEARS = 4;
  const now = new Date();
  const cutoff = new Date(now);
  cutoff.setFullYear(cutoff.getFullYear() - SOL_YEARS);
  const cutoffStr = cutoff.toISOString().split("T")[0];

  // Check if the FIRST call is older than 4 years
  if (offender.firstCallDate < cutoffStr) {
    // How many calls are time-barred?
    const barredCalls = offender.calls.filter((c) => c.date < cutoffStr);
    const validCalls = offender.calls.filter((c) => c.date >= cutoffStr);

    if (validCalls.length < 2) {
      return (
        `WARNING — STATUTE OF LIMITATIONS: The TCPA has a 4-year statute of ` +
        `limitations. Your earliest call(s) are older than 4 years. After ` +
        `excluding time-barred calls, you have only ${validCalls.length} valid ` +
        `call(s), which is below the 2-call TCPA threshold. This case may not ` +
        `be viable. Consult an attorney immediately.`
      );
    }

    return (
      `NOTICE — STATUTE OF LIMITATIONS: ${barredCalls.length} of your ` +
      `${offender.callCount} call(s) occurred more than 4 years ago and may ` +
      `be time-barred under the TCPA's statute of limitations. The petition ` +
      `includes all calls for context but you should be aware the court may ` +
      `exclude damages for calls before ${formatDate(cutoffStr)}. You still ` +
      `have ${validCalls.length} valid call(s) within the limitations period.`
    );
  }

  // Warn if approaching SOL (within 6 months)
  const warningCutoff = new Date(now);
  warningCutoff.setMonth(warningCutoff.getMonth() - (SOL_YEARS * 12 - 6));
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
  // Validate individual call records
  offender.calls.forEach((call, idx) => {
    if (!call.date) {
      throw new Error(`Call ${idx + 1}: missing date`);
    }
    if (!call.callSid) {
      throw new Error(`Call ${idx + 1}: missing call SID`);
    }
  });
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
  caseRef: string
): string {
  const company = offender.companyName
    ?? `Unknown Entity (Phone: ${offender.rawNumbers[0] ?? offender.normalizedNumber})`;
  const today = new Date();
  const todayStr = today.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
  const violationCount = offender.callCount;
  const damagesPerCall = offender.willful ? 1500 : 500;
  const totalDamages = offender.damagesEstimate;

  // If damages exceed small claims limit, cap them
  const limitNum = parseInt(config.smallClaimsLimit.replace(/[^0-9]/g, ""), 10) || 5000;
  const cappedDamages = Math.min(totalDamages, limitNum);
  const wasCapped = totalDamages > limitNum;

  // Determine if any calls were robocalls/automated (for § 227(b) count)
  const hasRobocalls = offender.calls.some(
    (c) => c.callType === "robocall" || c.callType === "telemarketing"
  );

  const callListForPetition = offender.calls
    .map((c, i) =>
      `        ${i + 1}. On ${formatDate(c.date)} at approximately ${c.time}` +
      `${c.recordingUrl ? " (recorded)" : ""}` +
      `${c.callType && c.callType !== "unknown" ? ` [${c.callType}]` : ""}`
    )
    .join("\n");

  // Track paragraph numbering
  let para = 1;
  const p = () => para++;

  return `═══════════════════════════════════════════════════════════════════════
                         ${config.courtName.toUpperCase()}
                    ${config.parishOrCounty.toUpperCase()}, ${config.courtState}
═══════════════════════════════════════════════════════════════════════

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

NOW INTO COURT, through this petition, comes ${config.userName},
Plaintiff herein, who respectfully represents:

                              I. PARTIES

${p()}.  Plaintiff, ${config.userName}, is a natural person residing at
    ${config.userAddress}, ${config.userCity}, ${config.courtState}
    ${config.userZip}, and is the residential telephone subscriber of
    telephone number ${config.userPhone}. Plaintiff had the right to
    expect no unsolicited calls in violation of the TCPA.

${p()}.  Defendant is ${company}, an entity that placed or caused to be
    placed unsolicited telephone calls to Plaintiff's telephone number.
    Defendant may be served at the address associated with telephone
    number ${offender.rawNumbers[0] ?? offender.normalizedNumber}.
${offender.callerNames.length > 0
  ? `    Known agent(s) of Defendant: ${offender.callerNames.join(", ")}.`
  : ""}

${p()}.  All calls at issue originated from or were made on behalf of
    Defendant, a single entity, within the 12-month period from
    ${formatDate(offender.firstCallDate)} to ${formatDate(offender.lastCallDate)}.

                          II. JURISDICTION

${p()}.  This Court has jurisdiction over this matter pursuant to
    ${config.smallClaimsStatute} and 47 U.S.C. § 227(c)(5).
    The amount in controversy does not exceed ${config.smallClaimsLimit}.

${p()}.  State courts have concurrent jurisdiction over private TCPA claims.
    See Mims v. Arrow Financial Services, LLC, 565 U.S. 368 (2012).

                         III. FACTS

${p()}.  Plaintiff's telephone number, ${config.userPhone}, has been
    registered on the National Do Not Call Registry maintained by the
    Federal Trade Commission since ${config.dncRegistrationDate}.

${p()}.  Despite this registration, Defendant placed ${violationCount}
    unsolicited telephone call(s) to Plaintiff's number between
    ${formatDate(offender.firstCallDate)} and ${formatDate(offender.lastCallDate)}.
    Each call constitutes a separate violation:

${callListForPetition}

${p()}.  Each call was answered by a recorded compliance system operating
    on Plaintiff's behalf, which captured the call under
    ${config.stateRecordingLaw}, a one-party consent jurisdiction.
    Full recordings, metadata, and transcripts are preserved and
    attached as exhibits.

${p()}.  ${offender.purpose
      ? `Defendant's calls were for the purpose of: ${offender.purpose}.`
      : "Defendant's calls were unsolicited commercial calls."}

${p()}. Plaintiff never provided prior express written consent to receive
    telephone calls from Defendant, and Defendant has produced no
    documentation of such consent. The burden of proving prior express
    consent rests with Defendant. See 47 C.F.R. § 64.1200(c).

${p()}. Plaintiff had no established business relationship ("EBR") with
    Defendant at any time relevant to this action. Plaintiff made no
    purchase, transaction, or inquiry with Defendant within 18 months
    prior to the calls at issue, nor any inquiry within 3 months prior.
    The EBR exception under 47 C.F.R. § 64.1200(f)(5) does not apply.

${offender.demandLetterSent
  ? `${p()}. On ${formatDate(offender.demandLetterDate!)}, Plaintiff sent a written
    cease-and-desist demand to Defendant via certified mail, requesting
    that Defendant immediately cease all calls to Plaintiff's number
    and pay statutory damages. ${offender.willful
      ? `Defendant knowingly and intentionally continued to call\n    Plaintiff's number after receiving said notice, demonstrating\n    willful violation of the TCPA. See 47 U.S.C. § 227(c)(5)(B).`
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

${p()}. Defendant violated these regulations by placing ${violationCount}
    call(s) to Plaintiff's registered telephone number within a
    12-month period.

${p()}. Under 47 U.S.C. § 227(c)(5), a person who has received more than
    one telephone call within any 12-month period by or on behalf of
    the same entity in violation of the regulations prescribed under
    this subsection may bring a private right of action to recover
    the greater of actual monetary loss or up to $500 in damages for
    each such violation.

${p()}. Plaintiff elects to recover statutory damages of $500 per
    violation (or $1,500 per violation if willful) rather than actual
    monetary loss, as statutory damages are greater.

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
    number ${violationCount} time(s) is circumstantial evidence that
    Defendant failed to maintain adequate DNC compliance procedures.
${hasRobocalls ? `
         COUNT II: VIOLATION OF 47 U.S.C. § 227(b)(1)(B)
         (Automated Telephone Dialing System / Robocalls)

${p()}. One or more of Defendant's calls to Plaintiff's telephone number
    were placed using an automatic telephone dialing system ("ATDS")
    or an artificial or prerecorded voice, as evidenced by the
    automated or prerecorded nature of the call documented in the
    attached recordings and transcripts.

${p()}. Under 47 U.S.C. § 227(b)(1)(B), it is unlawful to make any call
    using an ATDS or artificial/prerecorded voice to any telephone
    number assigned to a cellular telephone service without the prior
    express consent of the called party.

${p()}. Note: Under Facebook, Inc. v. Duguid, 141 S. Ct. 1163 (2021),
    an ATDS must use a random or sequential number generator to either
    store or produce telephone numbers. Plaintiff asserts that
    Defendant's calling equipment meets this definition based on the
    automated nature of the calls received.
` : ""}
${config.stateDncStatute !== "N/A"
  ? `         COUNT ${hasRobocalls ? "III" : "II"}: VIOLATION OF STATE DO-NOT-CALL LAW

${p()}. Defendant additionally violated ${config.stateDncStatute}, the
    state Do Not Call statute, which provides supplemental statutory
    damages and additional remedies including potential fines of
    $500 to $5,000 or more per violation, plus attorney fees for
    collection of said penalties.`
  : ""}

                        V. DAMAGES

${wasCapped
  ? `${p()}. Plaintiff is entitled to statutory damages of $${damagesPerCall}
    per violation × ${violationCount} violations = $${totalDamages.toLocaleString()}.
    However, Plaintiff voluntarily limits the claim to ${config.smallClaimsLimit}
    to remain within this Court's jurisdictional limit. Plaintiff
    reserves all rights to recover additional statutory damages in a
    court of competent jurisdiction.

${p()}. Plaintiff requests judgment in the amount of ${config.smallClaimsLimit}.`
  : `${p()}. Plaintiff is entitled to statutory damages of $${damagesPerCall}
    per violation × ${violationCount} violations = $${totalDamages.toLocaleString()}.

${p()}. Plaintiff requests judgment in the amount of $${totalDamages.toLocaleString()}.`}

${p()}. Plaintiff additionally requests reimbursement of court costs
    including filing fees and certified mail service charges.
    Plaintiff is representing herself/himself in proper person and
    does not seek attorney fees.

                        VI. PRAYER

WHEREFORE, Plaintiff prays that this Honorable Court:

    a) Enter judgment in favor of Plaintiff and against Defendant;

    b) Award Plaintiff statutory damages of $${cappedDamages.toLocaleString()};

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

I, ${config.userName}, do hereby verify under penalty of perjury
that the facts stated in this petition are true and correct to the
best of my knowledge, information, and belief.

${todayStr}


____________________________________
${config.userName}`;
}

// ─────────────────────────────────────────────────────────────────────────────
//  2. EVIDENCE EXHIBIT LIST
// ─────────────────────────────────────────────────────────────────────────────

function generateExhibitList(
  offender: OffenderProfile,
  config: FilingConfig,
  caseRef: string
): string {
  const company = offender.companyName ?? `Unknown Entity`;
  const today = new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });

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
        `    → Provide as USB drive, CD, or note the URL for the court.\n` +
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
      title: "Call Transcripts",
      description:
        `Transcripts of recorded calls with Defendant:\n\n${transcriptText}\n\n` +
        `    Note: Sensitive information (account numbers, etc.) has been\n` +
        `    redacted from transcripts. Full unredacted recordings are\n` +
        `    available for in camera review upon request.`,
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

  // Caller ID / phone records exhibit
  exhibits.push({
    letter: nextLetter(),
    title: "Phone Records / Caller ID Documentation",
    description:
      `Phone bill or call log showing incoming calls from:\n` +
      `    ${offender.rawNumbers.join(", ")}\n` +
      `    on the following dates: ${offender.calls.map((c) => c.date).join(", ")}.\n` +
      `    → Print the relevant pages from your phone bill or carrier app.`,
  });

  // Damages calculation exhibit
  const rate = offender.willful ? 1500 : 500;
  exhibits.push({
    letter: nextLetter(),
    title: "Damages Calculation",
    description:
      `Statutory damages under 47 U.S.C. § 227(c)(5):\n\n` +
      `    Violations:          ${offender.callCount}\n` +
      `    Rate per violation:  $${rate} ${offender.willful ? "(treble — willful)" : "(standard)"}\n` +
      `    Total damages:       $${offender.damagesEstimate.toLocaleString()}\n\n` +
      `    Calculation: ${offender.callCount} calls × $${rate}/violation = $${offender.damagesEstimate.toLocaleString()}\n` +
      `${offender.willful
        ? `\n    Treble damages apply because Defendant knowingly and\n` +
          `    intentionally continued calling after receiving a written\n` +
          `    cease-and-desist demand, demonstrating willful violation\n` +
          `    per 47 U.S.C. § 227(c)(5)(B).`
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
  caseRef: string
): string {
  const company = offender.companyName
    ?? `Unknown Entity (${offender.rawNumbers[0] ?? offender.normalizedNumber})`;
  const today = new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });

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

by the following method (check one):

    [ ] Certified Mail, Return Receipt Requested
        USPS Tracking Number: ________________________________

    [ ] Personal Service (by constable or process server)
        Server Name: _________________________________________
        Date/Time of Service: ________________________________

    [ ] Domiciliary Service
        Person served: _______________________________________
        Relationship to Defendant: ___________________________

    [ ] Service by Long Arm Statute (out-of-state Defendant)
        Method: ______________________________________________


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
  warnings: string[]
): string {
  const company = offender.companyName ?? "the spammer";
  const totalDamages = offender.damagesEstimate;

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
Your Damages:  $${totalDamages.toLocaleString()}
Court:         ${config.courtName}
               ${config.courtAddress}
               ${config.courtCity}, ${config.courtState} ${config.courtZip}
Clerk Phone:   ${config.courtClerkPhone}
${warningsBlock}
═══════════════════════════════════════════════════════════════════════

BEFORE YOU FILE — CHECKLIST
───────────────────────────

    [ ] Fill in your personal info in ALL documents if you see
        brackets like [YOUR NAME]
    [ ] Verify your DNC registration at https://www.donotcall.gov/verify.html
        and print/screenshot the confirmation
    [ ] Print your phone bill showing the spam calls
    [ ] Make sure recordings are saved (USB drive or accessible URL)
    ${offender.demandLetterSent
      ? "[ ] Gather your demand letter copy and certified mail receipt"
      : "[ ] RECOMMENDED: Send a demand letter first (SpamSlayer can\n        generate one). This strengthens your case AND can trigger\n        treble damages ($1,500/call) if they keep calling."}
    [ ] Confirm you have NO prior business relationship with ${company}
        (no purchases, no inquiries, no accounts)
    [ ] Confirm you never gave them written permission to call you

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
    → Collect the filing fee (${config.filingFee} — bring cash or
      check, call ${config.courtClerkPhone} to confirm)
    → Give you a court date (usually 2-4 weeks out)

═══════════════════════════════════════════════════════════════════════

STEP 3: SERVE THE DEFENDANT
────────────────────────────

You MUST give the defendant a copy of your petition before the
court date. Louisiana law requires proper service.

EASIEST METHOD — Certified mail:
    → Go to the post office
    → Send copies via Certified Mail with Return Receipt Requested
    → Cost: about ${config.serviceFee}
    → Keep the green receipt card — this is your PROOF of service
    → Fill in the tracking number on your Certificate of Service

If you don't have their address, see the tips in the Certificate
of Service document.

═══════════════════════════════════════════════════════════════════════

STEP 4: SHOW UP TO COURT
─────────────────────────

What to bring:
    → Your copy of everything (petition, exhibits, certificate)
    → Your phone (to play recordings if needed)
    → USB drive with recordings (backup)
    → Your phone bill showing the calls
    → DNC registry printout
    ${offender.demandLetterSent ? "→ Demand letter copy and certified mail receipt" : ""}

What to say (keep it simple):
    "Your Honor, I'm on the Do Not Call Registry. The defendant
     called me ${offender.callCount} times between ${formatDate(offender.firstCallDate)}
     and ${formatDate(offender.lastCallDate)}. I have recordings and phone
     records proving each call. Under the TCPA, I'm entitled to
     $${offender.willful ? "1,500" : "500"} per violation, totaling $${totalDamages.toLocaleString()}."

Then show your evidence when the judge asks.

IMPORTANT: The defendant probably WON'T show up. Most spammers
ignore small claims suits. If they don't appear, you win by
DEFAULT JUDGMENT — the judge rules in your favor automatically.

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

    4. "WE DIDN'T KNOW WE WERE VIOLATING THE LAW" — Irrelevant.
       Liability under 47 U.S.C. § 227(c)(5) does not require
       intent — it's a strict liability statute for the base
       $500 damages. Intent only matters for treble damages.

═══════════════════════════════════════════════════════════════════════

STEP 5: COLLECT YOUR MONEY
───────────────────────────

If you win (and you very likely will):

    a) The court issues a judgment in your favor.

    b) Appeals: Under La. C.C.P. Art. 4924, the PLAINTIFF cannot
       appeal a small claims judgment. The DEFENDANT can appeal
       from City Court to District Court within 10 days by posting
       a $75 deposit. However, most spammers do not bother. If the
       defendant does appeal, you re-argue your case in district
       court (same evidence, same arguments).

    c) If they don't pay, you can:
       → File for a Writ of Fieri Facias (wage garnishment)
       → Seize bank accounts
       → Place a lien on their property
       → The clerk can explain the collection process

═══════════════════════════════════════════════════════════════════════

KEY LEGAL REFERENCES (for your confidence)
──────────────────────────────────────────

    Federal:
    → 47 U.S.C. § 227(c)(5) — Private right of action, $500-$1,500
    → 47 U.S.C. § 227(b)(1)(B) — Robocall/ATDS prohibition
    → 47 C.F.R. § 64.1200(c) — DNC Registry regulations
    → 47 C.F.R. § 64.1200(c)(2) — Safe harbor (defendant's burden)
    → Mims v. Arrow Financial, 565 U.S. 368 (2012) — State court OK
    → Facebook v. Duguid, 141 S. Ct. 1163 (2021) — ATDS definition

    Louisiana:
    → ${config.stateDncStatute} — State DNC protections
    → ${config.stateRecordingLaw} — Recording is legal
    → ${config.smallClaimsStatute} — Small claims procedure
    → La. C.C.P. Art. 4924 — Appeal limitations

═══════════════════════════════════════════════════════════════════════

STATUTE OF LIMITATIONS REMINDER
────────────────────────────────

The TCPA has a 4-year statute of limitations. Your earliest call
was on ${formatDate(offender.firstCallDate)}. You must file this lawsuit
before ${formatDate(
    (() => {
      const d = new Date(offender.firstCallDate + "T00:00:00");
      d.setFullYear(d.getFullYear() + 4);
      return d.toISOString().split("T")[0];
    })()
  )} to preserve claims on all calls.

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

  const caseRef = generateCaseRef(offender);

  // Check for legal warnings (SOL, etc.)
  const warnings: string[] = [];
  const solWarning = checkStatuteOfLimitations(offender);
  if (solWarning) {
    warnings.push(solWarning);
    console.warn(`[LegalFiling] ${solWarning}`);
  }

  const pkg: FilingPackage = {
    petition: generatePetition(offender, config, caseRef),
    exhibitList: generateExhibitList(offender, config, caseRef),
    certificateOfService: generateCertificateOfService(offender, config, caseRef),
    filingGuide: generateFilingGuide(offender, config, caseRef, warnings),
    caseNumber: caseRef,
    generatedDate: new Date().toISOString(),
    offenderNumber: normalizedNumber,
    damagesRequested: offender.damagesEstimate,
    warnings,
  };

  console.log(
    `[LegalFiling] Generated filing package ${caseRef} for ${normalizedNumber} ` +
    `(${offender.companyName ?? "unknown"}) — $${offender.damagesEstimate.toLocaleString()} in damages` +
    `${warnings.length > 0 ? ` (${warnings.length} warning(s))` : ""}`
  );

  return pkg;
}

/**
 * Generate filing package and save all documents to disk as text files.
 * Returns the directory path where files were saved.
 *
 * Security: outputDir must be under the project's filings/ directory.
 */
export function generateAndSaveFilingPackage(
  normalizedNumber: string,
  outputDir?: string,
  configOverrides?: Partial<FilingConfig>
): { dir: string; files: string[] } | null {
  const pkg = generateFilingPackage(normalizedNumber, configOverrides);
  if (!pkg) return null;

  const baseDir = path.resolve(process.cwd(), "filings");
  let dir: string;

  if (outputDir) {
    // Prevent path traversal — output must be under filings/
    const resolvedDir = path.resolve(outputDir);
    if (!resolvedDir.startsWith(baseDir)) {
      throw new Error(
        `[LegalFiling] Security: output directory must be under ${baseDir}, ` +
        `got ${resolvedDir}`
      );
    }
    dir = resolvedDir;
  } else {
    dir = path.join(baseDir, pkg.caseNumber);
  }

  // Create directory if it doesn't exist
  fs.mkdirSync(dir, { recursive: true });

  const files: string[] = [];

  const writeDoc = (filename: string, content: string) => {
    const filepath = path.join(dir, filename);
    fs.writeFileSync(filepath, content, "utf-8");
    files.push(filepath);
  };

  writeDoc(`${pkg.caseNumber}_petition.txt`, pkg.petition);
  writeDoc(`${pkg.caseNumber}_exhibits.txt`, pkg.exhibitList);
  writeDoc(`${pkg.caseNumber}_certificate_of_service.txt`, pkg.certificateOfService);
  writeDoc(`${pkg.caseNumber}_filing_guide.txt`, pkg.filingGuide);

  // Also save a summary JSON for programmatic use
  writeDoc(`${pkg.caseNumber}_summary.json`, JSON.stringify({
    caseNumber: pkg.caseNumber,
    generatedDate: pkg.generatedDate,
    offenderNumber: pkg.offenderNumber,
    damagesRequested: pkg.damagesRequested,
    warnings: pkg.warnings,
    files: files.map((f) => path.basename(f)),
  }, null, 2));

  console.log(`[LegalFiling] Saved filing package to ${dir}:`);
  files.forEach((f) => {
    try {
      const size = fs.statSync(f).size;
      console.log(`  → ${path.basename(f)} (${size} bytes)`);
    } catch {
      console.log(`  → ${path.basename(f)}`);
    }
  });

  return { dir, files };
}
