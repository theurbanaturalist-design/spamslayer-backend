// ─────────────────────────────────────────────────────────────────────────────
//  caseBuilder.ts — TCPA case tracking across calls and users
//
//  Tracks every offender (by normalized phone number), counts violations,
//  flags cases as actionable when they hit the 2-call TCPA threshold,
//  calculates damages, and generates demand letters.
//
//  Persists to cases.json so data survives server restarts.
// ─────────────────────────────────────────────────────────────────────────────

import fs from "fs";
import path from "path";

const CASES_FILE = path.resolve(__dirname, "../../../cases.json");

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
}

type CasesDB = Record<string, OffenderProfile>;

// ── File I/O ─────────────────────────────────────────────────────────────

let writeInProgress = false;

function loadCases(): CasesDB {
  if (!fs.existsSync(CASES_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(CASES_FILE, "utf-8"));
  } catch {
    return {};
  }
}

function saveCases(db: CasesDB): void {
  // Simple mutex to prevent concurrent writes
  if (writeInProgress) {
    setTimeout(() => saveCases(db), 100);
    return;
  }
  writeInProgress = true;
  try {
    fs.writeFileSync(CASES_FILE, JSON.stringify(db, null, 2), "utf-8");
  } finally {
    writeInProgress = false;
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────

export function normalizePhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  return digits.slice(-10);
}

function isWithin12Months(date1: string, date2: string): boolean {
  try {
    const d1 = new Date(date1);
    const d2 = new Date(date2);
    const diffMs = Math.abs(d2.getTime() - d1.getTime());
    const diffDays = diffMs / (1000 * 60 * 60 * 24);
    return diffDays <= 365;
  } catch {
    return false;
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

  // If they called AFTER a demand letter was sent, mark as willful
  if (profile.demandLetterSent && profile.demandLetterDate) {
    const postDemandCalls = profile.calls.filter((c) => c.date > profile.demandLetterDate!);
    if (postDemandCalls.length > 0) {
      profile.willful = true;
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
  return db[normalizedNumber] ?? null;
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

export function generateDemandLetter(
  normalizedNumber: string,
  userName: string,
  userAddress: string,
  userPhone: string,
  dncSince: string = "2007"
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

My telephone number has been registered on the National Do Not Call
Registry since ${dncSince}. Despite this registration, your company has
placed ${profile.callCount} unsolicited telephone call(s) to my number
between ${profile.firstCallDate} and ${profile.lastCallDate}:

${callList}

All calls were answered by an automated compliance system, recorded
under Louisiana's one-party consent law (La. R.S. 15:1303), and
documented with full metadata including timestamps and recordings.

Under 47 U.S.C. Section 227(c)(5), any person who has received more
than one telephone call within any 12-month period by or on behalf of
the same entity in violation of the regulations prescribed under this
subsection may bring a private action for actual monetary loss or
receive up to $500 in damages for each such violation, whichever is
greater.

${profile.willful ? `Your company continued to call after receiving a prior cease-and-desist
notice, demonstrating willful or knowing violation of the regulations.
Under 47 U.S.C. Section 227(c)(5)(B), the court may treble damages
to $1,500 per violation.\n` : ""}Based on ${profile.callCount} violation(s), I am entitled to statutory
damages of $${profile.damagesEstimate.toLocaleString()}.

DEMAND

I hereby demand that you:

    1. Immediately cease all calls to ${userPhone}.
    2. Place ${userPhone} on your internal do-not-call list.
    3. Pay $${profile.damagesEstimate.toLocaleString()} in statutory damages within
       thirty (30) days of receipt of this letter
       (by ${deadline.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })}).

If payment is not received by the deadline above, I will file suit in
the City Court of Lafayette, Lafayette Parish, Louisiana, seeking the
maximum statutory damages permitted under 47 U.S.C. Section 227(c)(5),
plus court costs. See Mims v. Arrow Financial Services, 565 U.S. 368
(2012) (state courts have concurrent jurisdiction over TCPA claims).

NOTE: Under Louisiana Code of Civil Procedure Article 4924, there is
no right of appeal from small claims judgments for the plaintiff. I am
prepared to accept this limitation.

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
