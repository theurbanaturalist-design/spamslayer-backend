// ─────────────────────────────────────────────────────────────────────────────
//  filingDecision.ts — single GO / WAIT / DON'T FILE verdict engine
//
//  The user's question: "Before I write a $75 check at the courthouse, is the
//  system telling me clearly whether to file?"
//
//  Until now, the answer was scattered:
//    - Case strength score lived in caseStrengthMeter.ts
//    - Collectability score lived in defendantResearch.ts
//    - Win/collect odds (~40-55% / ~5-10%) lived in CASE_STAGES_GUIDE.txt
//    - Evidence completeness lived in evidenceChecklist.ts
//
//  This module combines all four signals into ONE verdict with reasoning.
//  Outputs:
//    GO         — file. Strong case + collectable + evidence complete.
//                 Expected return clearly exceeds filing fee.
//    WAIT       — promising but not yet. Specific actions to take first.
//    DONT_FILE  — uncollectable defendant or case too weak. Don't burn $75.
//                 The regulatory complaints (FCC/state-AG/ITG) still go in.
//
//  The verdict is shown on the dashboard, included in Discord embeds, written
//  to the filing_guide.txt header, AND blocks the save path unless the user
//  explicitly overrides.
// ─────────────────────────────────────────────────────────────────────────────

import type { OffenderProfile } from "./caseBuilder";
import { evaluateCaseStrength } from "./caseStrengthMeter";
import { scoreCollectability } from "./defendantResearch";

export type FilingVerdict = "GO" | "WAIT" | "DONT_FILE";

export interface FilingDecision {
  verdict: FilingVerdict;
  /** 0-100 confidence in the verdict itself. Lower confidence = closer call. */
  confidence: number;
  /** Plain-English bullet points explaining the verdict. */
  reasoning: string[];
  /** Specific actions the user should take. Different per verdict. */
  recommendedActions: string[];
  /** Probability-weighted expected return on filing, in USD. Negative = lose money. */
  expectedValueUsd: number;
  /** Total expected costs to file (filing fee + service + cert mail + ~labor proxy). */
  costEstimateUsd: number;
  /** Statutory damages claimed (best case if you win + collect 100%). */
  statutoryDamagesUsd: number;
  /** Per-component breakdown for the dashboard expanded view. */
  breakdown: {
    caseStrengthScore: number;        // 0-100 from caseStrengthMeter
    caseStrengthRating: string;       // WEAK / MODERATE / STRONG / NOT_READY
    collectabilityScore: number | null;     // 0-100 from defendantResearch (may be null if not run)
    collectabilityBand: "LOW" | "MEDIUM" | "HIGH" | "UNKNOWN";
    evidenceCompletenessPct: number;  // 0-100 from evidenceChecklist
    pWinJudgment: number;             // 0-1 probability of winning OR getting default
    pCollectGivenWin: number;         // 0-1 conditional probability of collecting if you win
    sonarFlags: string[];             // notable signals from defendantWebResearch
  };
}

// ─────────────────────────────────────────────────────────────────────────────
//  Constants
// ─────────────────────────────────────────────────────────────────────────────

// Realistic cost stack for a Lafayette City Court small-claims TCPA filing
// (per legal audit + actual LA city-court fee schedules):
//   - Filing fee:               $75
//   - Sheriff service:          $40
//   - Demand letter cert mail:  $9
//   - Misc (copies, postage):   $10
const COST_FILING_FEE = 75;
const COST_SERVICE = 40;
const COST_DEMAND_MAIL = 9;
const COST_MISC = 10;
const TOTAL_COST_USD = COST_FILING_FEE + COST_SERVICE + COST_DEMAND_MAIL + COST_MISC; // ~$134

// Win/collect probability priors from the legal audit. These are baselines
// for an average pro-se TCPA small-claims case; we adjust up/down based on
// per-case signals below.
const BASE_P_WIN_JUDGMENT = 0.50;       // 40-55% range; midpoint
const BASE_P_COLLECT_GIVEN_WIN = 0.075; // 5-10% range; midpoint

// ─────────────────────────────────────────────────────────────────────────────
//  Decision engine
// ─────────────────────────────────────────────────────────────────────────────

export function decideFiling(offender: OffenderProfile): FilingDecision {
  const reasoning: string[] = [];
  const recommendedActions: string[] = [];

  // ── Component 1: case strength ──
  const strength = evaluateCaseStrength(offender.normalizedNumber);
  const caseStrengthScore = strength?.score ?? 0;
  const caseStrengthRating = strength?.rating ?? "NOT_READY";

  // ── Component 2: collectability ──
  // Compute inline using the same scorer that defendantResearch uses,
  // threading in the cached entityLookup + priorLitigation enrichment if
  // available. This keeps the verdict accurate even before a filing
  // packet has been generated.
  const enrichment = buildEnrichmentFromProfile(offender);
  const collect = scoreCollectability(offender, { enrichment });
  const collectabilityScore = collect?.score ?? null;
  // Widen the band to include UNKNOWN explicitly. scoreCollectability never
  // returns UNKNOWN today (it always falls back to LOW), but if defendant
  // research wasn't run at all we need a sentinel value the verdict logic
  // can route on. Use a let + manual assignment to keep the union open.
  let collectabilityBand: "LOW" | "MEDIUM" | "HIGH" | "UNKNOWN" = "UNKNOWN";
  if (collect?.band === "LOW" || collect?.band === "MEDIUM" || collect?.band === "HIGH") {
    collectabilityBand = collect.band;
  }

  // ── Component 3: evidence completeness ──
  const cl = offender.evidenceChecklist;
  const totalItems = cl?.items.length ?? 0;
  const doneItems = cl?.items.filter((i) => i.completed).length ?? 0;
  const evidenceCompletenessPct = totalItems > 0
    ? Math.round((doneItems / totalItems) * 100)
    : 0;

  // ── Component 4: Sonar flags ──
  const sonarFlags: string[] = [];
  const sonar = offender.defendantWebResearch;
  if (sonar?.status === "match" && typeof sonar.summary === "string") {
    const s = sonar.summary.toLowerCase();
    if (/dissolved|forfeited|cancelled|terminated/.test(s)) sonarFlags.push("Sonar: defendant entity may be dissolved/forfeited");
    if (/registered agent/.test(s)) sonarFlags.push("Sonar: registered agent identifiable");
    if (/multiple|disparate|ambiguous|unable to identify|not found/.test(s)) sonarFlags.push("Sonar: defendant identity ambiguous");
    if (/ftc|fcc|state.+attorney general|enforcement/.test(s)) sonarFlags.push("Sonar: prior regulatory enforcement found");
    if (/tcpa|telephone consumer protection|robocall/.test(s)) sonarFlags.push("Sonar: prior TCPA litigation found");
  }

  // ── Adjust probabilities based on signals ──
  let pWin = BASE_P_WIN_JUDGMENT;
  let pCollect = BASE_P_COLLECT_GIVEN_WIN;

  // Case strength shifts pWin meaningfully
  if (caseStrengthScore >= 80) { pWin += 0.20; reasoning.push(`Case strength STRONG (${caseStrengthScore}/100) — bumps win probability to ~70%`); }
  else if (caseStrengthScore >= 60) { pWin += 0.10; reasoning.push(`Case strength MODERATE (${caseStrengthScore}/100) — slight bump to win probability`); }
  else if (caseStrengthScore < 40) { pWin -= 0.20; reasoning.push(`Case strength WEAK (${caseStrengthScore}/100) — drops win probability to ~30%`); }
  else { reasoning.push(`Case strength middling (${caseStrengthScore}/100)`); }

  // Collectability shifts pCollect dramatically (this is the bottleneck)
  if (collectabilityBand === "HIGH") { pCollect = 0.30; reasoning.push("Collectability HIGH — defendant findable + likely has assets"); }
  else if (collectabilityBand === "MEDIUM") { pCollect = 0.15; reasoning.push("Collectability MEDIUM — defendant findable but assets unclear"); }
  else if (collectabilityBand === "LOW") { pCollect = 0.02; reasoning.push("Collectability LOW — defendant likely a spoofed-VoIP shell with no US assets"); }
  else { reasoning.push("Collectability UNKNOWN — defendant research not yet run; assume baseline"); }

  // Evidence completeness shifts pWin (more evidence = harder to dispute)
  if (evidenceCompletenessPct >= 70) { pWin += 0.10; reasoning.push(`Evidence checklist ${evidenceCompletenessPct}% complete — strong third-party corroboration`); }
  else if (evidenceCompletenessPct < 30) { pWin -= 0.10; reasoning.push(`Evidence checklist only ${evidenceCompletenessPct}% complete — petition mostly relies on Twilio recording alone`); }

  // Sonar dissolved flag is a near-certain DON'T FILE
  if (sonarFlags.some((f) => /dissolved|forfeited/.test(f))) {
    pCollect = Math.min(pCollect, 0.005);
    reasoning.push("Sonar surfaced 'dissolved/forfeited' signal — defendant cannot pay even if you win");
  }

  // Sonar prior-litigation flag is a positive signal — defendants who've
  // settled before are more likely to settle yours.
  if (sonarFlags.some((f) => /prior TCPA litigation/.test(f))) {
    pWin += 0.10;
    pCollect += 0.10;
    reasoning.push("Sonar found prior TCPA litigation — defendant has counsel + history of settling");
  }

  // Clamp
  pWin = Math.max(0.05, Math.min(0.95, pWin));
  pCollect = Math.max(0.005, Math.min(0.95, pCollect));

  // ── Expected value math ──
  const statutoryDamagesUsd = offender.damagesEstimate ?? 0;
  const expectedReturn = statutoryDamagesUsd * pWin * pCollect;
  const expectedNet = expectedReturn - TOTAL_COST_USD;

  // ── Verdict logic ──
  let verdict: FilingVerdict;
  let confidence = 70;

  // Hard rules first
  if (caseStrengthRating === "NOT_READY") {
    verdict = "DONT_FILE";
    confidence = 95;
    reasoning.unshift("HARD RULE: case strength meter says NOT_READY (not enough calls in window or other gating issue)");
    recommendedActions.push("Wait for more calls or fix the underlying issue (see case-strength meter detail).");
  } else if (collectabilityBand === "LOW" && caseStrengthScore < 70) {
    verdict = "DONT_FILE";
    confidence = 85;
    reasoning.unshift(`HARD RULE: low collectability + sub-strong case = expected loss of ~$${(TOTAL_COST_USD - expectedReturn).toFixed(0)} on filing fee + costs`);
    recommendedActions.push("Skip the petition. File the FCC complaint, state-AG complaint, and ITG traceback instead — those are free and create regulatory pressure.");
    recommendedActions.push("If more calls come in (especially post-demand-letter calls = trebled damages), revisit this verdict.");
  } else if (sonarFlags.some((f) => /dissolved|forfeited/.test(f))) {
    verdict = "DONT_FILE";
    confidence = 90;
    reasoning.unshift("HARD RULE: defendant entity appears to be dissolved or forfeited — judgment uncollectable");
    recommendedActions.push("Sue the upstream lead-buyer or seller instead (TCPA seller-liability theory, FCC 2013 DISH ruling). The petition draft has the legal mechanics; you'd need to identify the seller via your Sonar research.");
  } else if (expectedNet > 100 && evidenceCompletenessPct >= 70) {
    verdict = "GO";
    confidence = 80;
    reasoning.unshift(`Expected return $${expectedReturn.toFixed(0)} comfortably exceeds total costs of $${TOTAL_COST_USD} (margin: $${expectedNet.toFixed(0)})`);
    recommendedActions.push("Generate the filing packet and file. You've done the prep work; the math is in your favor.");
  } else if (expectedNet > -50 && evidenceCompletenessPct < 70) {
    verdict = "WAIT";
    confidence = 70;
    reasoning.unshift(`Expected return ($${expectedReturn.toFixed(0)}) is in the break-even zone — but evidence checklist is only ${evidenceCompletenessPct}% done. Closing the evidence gap meaningfully shifts the math.`);
    recommendedActions.push("Open the evidence checklist on the dashboard. File the ITG traceback first (5 min, free, biggest leverage on win probability).");
    recommendedActions.push("Screenshot AT&T usage detail (5 min, free).");
    recommendedActions.push(`After the checklist is at 70%+, the verdict will likely flip to GO. Re-check this decision then.`);
  } else if (expectedNet > 0) {
    verdict = "GO";
    confidence = 60;
    reasoning.unshift(`Expected return $${expectedReturn.toFixed(0)} marginally exceeds costs of $${TOTAL_COST_USD}. Close call — file if you want the regulatory pressure benefit even if collection fails.`);
    recommendedActions.push("Acceptable to file. The petition itself creates a public record that pressures the spammer regardless of collection.");
  } else {
    verdict = "WAIT";
    confidence = 65;
    reasoning.unshift(`Expected return $${expectedReturn.toFixed(0)} is below total costs of $${TOTAL_COST_USD}. Don't file yet — the math doesn't pencil.`);
    if (collectabilityBand === "UNKNOWN") {
      recommendedActions.push("Defendant research hasn't fully completed yet. Re-check this verdict in a few minutes once Sonar + CourtListener finish.");
    }
    recommendedActions.push("Send the demand letter (free). Track for any post-demand calls — those are trebled at $1,500 each, which can flip the math.");
    recommendedActions.push("File the FCC + state-AG complaints in parallel. Free, builds the case file.");
  }

  // Always include this universal action regardless of verdict
  if (!recommendedActions.some((a) => /FCC.*complaint/.test(a))) {
    recommendedActions.push("File the FCC complaint regardless of verdict — it's free and creates a docket number for the case file.");
  }

  return {
    verdict,
    confidence,
    reasoning,
    recommendedActions,
    expectedValueUsd: Math.round(expectedReturn),
    costEstimateUsd: TOTAL_COST_USD,
    statutoryDamagesUsd,
    breakdown: {
      caseStrengthScore,
      caseStrengthRating,
      collectabilityScore,
      collectabilityBand,
      evidenceCompletenessPct,
      pWinJudgment: Math.round(pWin * 100) / 100,
      pCollectGivenWin: Math.round(pCollect * 100) / 100,
      sonarFlags,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
//  Internal: marshal cached enrichment from OffenderProfile into the
//  EnrichmentResult shape that scoreCollectability expects. Mirrors the
//  same conversion done in legalFilingGenerator.ts.
// ─────────────────────────────────────────────────────────────────────────────

function buildEnrichmentFromProfile(offender: OffenderProfile): any {
  const enrichment: any = {};
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
  return Object.keys(enrichment).length > 0 ? enrichment : undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Pretty-printer for the filing_guide.txt header
// ─────────────────────────────────────────────────────────────────────────────

export function renderDecisionForFilingGuide(decision: FilingDecision): string {
  const verdictGlyph = decision.verdict === "GO" ? "✅" : decision.verdict === "WAIT" ? "⏸" : "🛑";
  const verdictBox =
    decision.verdict === "GO"
      ? "GO — file the petition"
      : decision.verdict === "WAIT"
      ? "WAIT — gather more first"
      : "DON'T FILE — costs > expected return";

  const lines: string[] = [
    "═══════════════════════════════════════════════════════════════════════",
    `   ${verdictGlyph}  FILING DECISION:  ${verdictBox}`,
    `   Confidence: ${decision.confidence}%`,
    "═══════════════════════════════════════════════════════════════════════",
    "",
    `  Statutory damages claimed:     $${decision.statutoryDamagesUsd.toLocaleString()}`,
    `  Filing + service + costs:      $${decision.costEstimateUsd.toLocaleString()}`,
    `  Probability-weighted return:   $${decision.expectedValueUsd.toLocaleString()}`,
    `  Net expected value:            $${(decision.expectedValueUsd - decision.costEstimateUsd).toLocaleString()}`,
    "",
    `  Win probability:               ${Math.round(decision.breakdown.pWinJudgment * 100)}% (judgment or default)`,
    `  Collect probability:           ${Math.round(decision.breakdown.pCollectGivenWin * 100)}% (conditional on winning)`,
    "",
    "  Why:",
    ...decision.reasoning.map((r) => `    • ${r}`),
    "",
    "  Recommended actions:",
    ...decision.recommendedActions.map((a) => `    → ${a}`),
    "",
    "═══════════════════════════════════════════════════════════════════════",
    "",
  ];
  return lines.join("\n");
}
