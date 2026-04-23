// ─────────────────────────────────────────────────────────────────────────────
//  caseStrengthMeter.ts — Evaluate case viability before filing
//
//  Scores a TCPA case from 0-100 and provides a rating (STRONG / MODERATE /
//  WEAK / NOT READY). Warns users away from filing weak cases and tells them
//  exactly what to do to strengthen their position.
//
//  Used by legalFilingGenerator before generating documents, and can be
//  exposed via API so users see their case strength in real time.
// ─────────────────────────────────────────────────────────────────────────────

import { OffenderProfile, getOffender } from "./caseBuilder";

// ── Types ────────────────────────────────────────────────────────────────

export type CaseRating = "STRONG" | "MODERATE" | "WEAK" | "NOT_READY";

export interface CaseStrengthFactor {
  name: string;
  points: number;        // points awarded (0 if not met)
  maxPoints: number;     // max possible for this factor
  met: boolean;
  tip: string;           // what to do if not met
}

export interface CaseStrengthReport {
  rating: CaseRating;
  score: number;          // 0-100
  summary: string;        // one-line human-readable verdict
  factors: CaseStrengthFactor[];
  recommendation: string; // what to do next
  readyToFile: boolean;
}

// ── Scoring logic ───────────────────────────────────────────────────────
//
//  Factor                           Max Points
//  ─────────────────────────────────────────────
//  2+ calls in 12 months (required)    15
//  Company name identified              10
//  Caller name identified                5
//  Recordings available                 20
//  Transcripts available                10
//  DNC registration confirmed            5  (we can't auto-check, but we
//                                            trust the config)
//  Demand letter sent                   15
//  Willful (post-demand calls)          10
//  Multiple calls (3+)                   5
//  Many calls (5+)                       5
//  ─────────────────────────────────────────────
//  TOTAL                               100

export function evaluateCaseStrength(
  normalizedNumber: string
): CaseStrengthReport | null {
  const offender = getOffender(normalizedNumber);
  if (!offender) {
    return null;
  }

  const factors: CaseStrengthFactor[] = [];

  // ── Factor 1: Minimum threshold (2+ calls in 12 months) ──────────
  const meetsThreshold = offender.actionable && offender.callCount >= 2;
  factors.push({
    name: "TCPA threshold (2+ calls in 12 months)",
    points: meetsThreshold ? 15 : 0,
    maxPoints: 15,
    met: meetsThreshold,
    tip: meetsThreshold
      ? "Threshold met — you have a valid cause of action."
      : "You need at least 2 calls from the same entity within 12 months. " +
        "Keep SpamSlayer running — if they call again, you'll hit the threshold.",
  });

  // ── Factor 2: Company name identified ─────────────────────────────
  const hasCompany = !!offender.companyName;
  factors.push({
    name: "Company name identified",
    points: hasCompany ? 10 : 0,
    maxPoints: 10,
    met: hasCompany,
    tip: hasCompany
      ? `Identified: ${offender.companyName}`
      : "We don't know who's calling. Without a company name, you can still " +
        "file using the phone number, but it's harder to serve them. " +
        "SpamSlayer will keep trying to extract this on future calls.",
  });

  // ── Factor 3: Caller name identified ──────────────────────────────
  const hasCallerName = offender.callerNames.length > 0;
  factors.push({
    name: "Individual caller name identified",
    points: hasCallerName ? 5 : 0,
    maxPoints: 5,
    met: hasCallerName,
    tip: hasCallerName
      ? `Names: ${offender.callerNames.join(", ")}`
      : "No individual name extracted yet. This is nice to have but not " +
        "required — the company is what matters for TCPA liability.",
  });

  // ── Factor 4: Call recordings ─────────────────────────────────────
  const recordedCalls = offender.calls.filter((c) => c.recordingUrl);
  const hasRecordings = recordedCalls.length > 0;
  const allRecorded = recordedCalls.length === offender.calls.length;
  factors.push({
    name: "Call recordings available",
    points: allRecorded ? 20 : hasRecordings ? 12 : 0,
    maxPoints: 20,
    met: hasRecordings,
    tip: allRecorded
      ? `All ${recordedCalls.length} call(s) recorded — excellent evidence.`
      : hasRecordings
        ? `${recordedCalls.length} of ${offender.callCount} calls recorded. ` +
          `Partial recordings still help, but try to record every call.`
        : "NO RECORDINGS. This is your biggest weakness. Without recordings, " +
          "it's your word against theirs. Make sure call recording is enabled " +
          "in your SpamSlayer config.",
  });

  // ── Factor 5: Transcripts ────────────────────────────────────────
  const callsWithTranscripts = offender.calls.filter((c) => c.transcriptSnippet);
  const hasTranscripts = callsWithTranscripts.length > 0;
  factors.push({
    name: "Call transcripts available",
    points: hasTranscripts ? 10 : 0,
    maxPoints: 10,
    met: hasTranscripts,
    tip: hasTranscripts
      ? `${callsWithTranscripts.length} call(s) have transcripts.`
      : "No transcripts. Recordings alone are sufficient, but transcripts " +
        "make it easier for the judge to review quickly.",
  });

  // ── Factor 6: DNC registration ───────────────────────────────────
  // We assume it's configured correctly — the user will verify at filing time
  factors.push({
    name: "DNC registration confirmed",
    points: 5,
    maxPoints: 5,
    met: true,
    tip: "Remember to verify at https://www.donotcall.gov/verify.html " +
         "and print the confirmation before filing.",
  });

  // ── Factor 7: Demand letter sent ─────────────────────────────────
  const hasDemand = offender.demandLetterSent;
  factors.push({
    name: "Demand letter sent via certified mail",
    points: hasDemand ? 15 : 0,
    maxPoints: 15,
    met: hasDemand,
    tip: hasDemand
      ? `Demand sent on ${offender.demandLetterDate}. This strengthens your ` +
        `case significantly and may enable treble damages.`
      : "STRONGLY RECOMMENDED: Send a demand letter before filing. " +
        "This does two things: (1) gives the spammer a chance to pay up " +
        "without going to court, and (2) if they keep calling after the " +
        "demand, your damages TRIPLE from $500 to $1,500 per call. " +
        "Use SpamSlayer's demand letter generator.",
  });

  // ── Factor 8: Willful violations ─────────────────────────────────
  const isWillful = offender.willful;
  factors.push({
    name: "Willful violation (post-demand calls)",
    points: isWillful ? 10 : 0,
    maxPoints: 10,
    met: isWillful,
    tip: isWillful
      ? "Defendant called AFTER your demand letter — treble damages ($1,500/call)."
      : hasDemand
        ? "Defendant stopped calling after your demand. Good news: they complied. " +
          "Bad news: no treble damages. You can still file for $500/call."
        : "Send a demand letter first. If they call again after that, " +
          "damages jump to $1,500 per call.",
  });

  // ── Factor 9: Multiple calls (3+) ────────────────────────────────
  const hasManyCallsLow = offender.callCount >= 3;
  factors.push({
    name: "3+ documented calls",
    points: hasManyCallsLow ? 5 : 0,
    maxPoints: 5,
    met: hasManyCallsLow,
    tip: hasManyCallsLow
      ? `${offender.callCount} calls documented — stronger pattern of violations.`
      : "Only 2 calls. That meets the minimum, but more calls = more " +
        "damages and a stronger pattern for the judge to see.",
  });

  // ── Factor 10: Many calls (5+) ───────────────────────────────────
  const hasManyCallsHigh = offender.callCount >= 5;
  factors.push({
    name: "5+ documented calls",
    points: hasManyCallsHigh ? 5 : 0,
    maxPoints: 5,
    met: hasManyCallsHigh,
    tip: hasManyCallsHigh
      ? `${offender.callCount} calls — very strong pattern. ` +
        `Estimated damages: $${offender.damagesEstimate.toLocaleString()}.`
      : "More calls strengthen your case and increase damages.",
  });

  // ── Calculate total score ─────────────────────────────────────────
  const score = factors.reduce((sum, f) => sum + f.points, 0);

  // ── Determine rating ──────────────────────────────────────────────
  let rating: CaseRating;
  let summary: string;
  let recommendation: string;
  let readyToFile: boolean;

  if (!meetsThreshold) {
    rating = "NOT_READY";
    summary = "Case does not meet the TCPA 2-call threshold yet.";
    recommendation =
      "Keep SpamSlayer running. You need at least one more call from this " +
      "entity to have a valid TCPA private right of action. Do NOT file yet.";
    readyToFile = false;
  } else if (!hasCompany) {
    // Unknown defendant is a fatal procedural defect — courts cannot
    // enter judgment against a phone number. Block filing regardless of score.
    rating = "NOT_READY";
    summary = `Case blocked (${score}/100). Defendant not identified — courts cannot enter judgment against a phone number.`;
    recommendation =
      "CRITICAL: SpamSlayer has not identified the company behind this number. " +
      "Courts CANNOT enter judgment against 'Unknown Entity.' You must identify " +
      "the defendant's legal business name before filing. Search the phone number " +
      "on TrueCaller, Whitepages, or the FCC complaint database. Check your " +
      "state's Secretary of State business registry. Wait for another call — " +
      "SpamSlayer will keep trying to extract the company name.";
    readyToFile = false;
  } else if (score >= 75) {
    rating = "STRONG";
    summary = `Strong case (${score}/100). You have solid evidence and a clear violation pattern.`;
    recommendation =
      "This case is ready to file. Generate your filing package and head " +
      "to the courthouse. Your evidence is strong and your legal position " +
      "is well-supported.";
    readyToFile = true;
  } else if (score >= 50) {
    rating = "MODERATE";
    summary = `Moderate case (${score}/100). Winnable, but could be stronger.`;
    const unmet = factors.filter((f) => !f.met);
    recommendation =
      "You CAN file this case, but consider strengthening it first. " +
      `Key improvements: ${unmet.map((f) => f.name).join(", ")}. ` +
      "See the tips below for each factor.";
    readyToFile = true;
  } else {
    rating = "WEAK";
    summary = `Weak case (${score}/100). Filing now carries significant risk.`;
    const unmet = factors.filter((f) => !f.met);
    recommendation =
      "This case needs more work before filing. A weak case wastes your " +
      "filing fee and court time. Focus on: " +
      `${unmet.slice(0, 3).map((f) => f.name).join(", ")}. ` +
      "Build your evidence, then reassess.";
    readyToFile = false;
  }

  const report: CaseStrengthReport = {
    rating,
    score,
    summary,
    factors,
    recommendation,
    readyToFile,
  };

  console.log(
    `[CaseStrength] ${normalizedNumber}: ${rating} (${score}/100) — ` +
    `${offender.companyName ?? "unknown"}, ${offender.callCount} calls, ` +
    `$${offender.damagesEstimate.toLocaleString()}`
  );

  return report;
}

/**
 * Generate a human-readable case strength report as formatted text.
 * Suitable for inclusion in notifications or the filing package.
 */
export function formatCaseStrengthReport(report: CaseStrengthReport): string {
  const bar = (points: number, max: number): string => {
    const filled = Math.round((points / max) * 10);
    return "█".repeat(filled) + "░".repeat(10 - filled);
  };

  let text = `═══════════════════════════════════════════════════════════════════════
                      CASE STRENGTH ASSESSMENT
═══════════════════════════════════════════════════════════════════════

  Rating:  ${report.rating}
  Score:   ${report.score}/100  ${bar(report.score, 100)}
  Verdict: ${report.summary}

───────────────────────────────────────────────────────────────────────

  ${report.recommendation}

───────────────────────────────────────────────────────────────────────
  FACTOR BREAKDOWN
───────────────────────────────────────────────────────────────────────

`;

  report.factors.forEach((f) => {
    const status = f.met ? "✓" : "✗";
    const pointStr = `${f.points}/${f.maxPoints}`;
    text += `  ${status} ${f.name.padEnd(42)} ${pointStr.padStart(6)}  ${bar(f.points, f.maxPoints)}\n`;
    text += `    ${f.tip}\n\n`;
  });

  text += `═══════════════════════════════════════════════════════════════════════\n`;

  return text;
}
