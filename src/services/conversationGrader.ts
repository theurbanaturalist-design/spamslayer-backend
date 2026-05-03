// ─────────────────────────────────────────────────────────────────────────────
//  conversationGrader.ts — Score a single spam call on how well the bot did.
//
//  Pure / deterministic. No network calls, no external state. Given a call's
//  raw conversation turns plus the post-call extracted fields, return a
//  letter grade A-F, a 0-100 score, a per-factor breakdown, a hang-up risk
//  enum, and a list of missing fields.
//
//  Used for two things:
//    1. Per-call telemetry (Discord/SMS notifications, dashboard).
//    2. Aggregate readiness: "what % of last 30 days' calls extracted the
//       company name?" — measurable signal that the persona is working.
//
//  Rubric (100-point scale):
//    + 30  company name extracted
//    + 15  caller name extracted
//    + 15  purpose extracted
//    + 15  recording captured
//    + 15  conversation length in [3,8]-turn sweet spot (graded ramp)
//    + 10  caller heard the warning (last turn was the bot, not caller)
//    -----
//    Penalties (subtract):
//    - 10  any bot turn leaks AI/persona tokens ("EXTRACTED:", "WARNING",
//          "I'm an AI", "language model")
//    -  5  consecutive duplicate bot questions (sign of stuck loop)
//
//  Bands: A 90+ / B 80-89 / C 70-79 / D 60-69 / F <60
//  Hang-up risk: low / medium / high — orthogonal to grade.
// ─────────────────────────────────────────────────────────────────────────────

export interface ConversationTurn {
  role: "caller" | "bot";
  text: string;
}

export interface CallSummaryForGrading {
  callSid: string;
  companyName: string | null;
  callerName: string | null;
  purpose: string | null;
  recordingUrl: string | null;
  turns: ConversationTurn[];
}

export type LetterGrade = "A" | "B" | "C" | "D" | "F" | "INCOMPLETE";
export type HangUpRisk = "low" | "medium" | "high";

export interface GradeFactor {
  name: string;
  weight: number;     // max points this factor can contribute
  earned: number;     // points actually awarded (can be negative for penalties)
  reason: string;     // one-line explanation
}

export interface ConversationGrade {
  callSid: string;
  grade: LetterGrade;
  score: number;          // 0-100, clamped
  factors: GradeFactor[];
  hangUpRisk: HangUpRisk;
  missingInfo: Array<"company" | "name" | "purpose" | "recording">;
  /** Short human-readable summary, suitable for a Discord embed line. */
  summary: string;
}

// ── Constants ─────────────────────────────────────────────────────────────

const W_COMPANY = 30;
const W_NAME = 15;
const W_PURPOSE = 15;
const W_RECORDING = 15;
const W_LENGTH = 15;
const W_HEARD_WARNING = 10;

const PENALTY_PERSONA_LEAK = -10;
const PENALTY_LOOP = -5;

/** Patterns that, if present in any bot turn, indicate the persona broke. */
const PERSONA_LEAK_PATTERNS: RegExp[] = [
  /\bEXTRACTED:/i,
  /\bWARNING\b(?!.*Do Not Call)/i,    // bare WARNING token, not the warning text
  /\bDONE\b(?!\s+(deal|with))/i,       // bare DONE token
  /\bI('?| a)m an AI\b/i,
  /\blanguage model\b/i,
  /\bas an AI\b/i,
  /\bautomated (system|bot)\b/i,
  /\bai assistant\b/i,
  // P4.3: TwiML markup leaks. If Twilio's TTS speaks raw XML (because
  // we accidentally interpolated TwiML into a `<Say>` body), the spammer
  // hears "less than gather greater than" out loud — the persona is dead.
  /<\s*\/?\s*(Say|Gather|Record|Hangup|Response|Pause|Play|Dial|Redirect)\b/i,
  // Template literals that didn't get interpolated (e.g. ${variable}, {{var}}).
  /\$\{[^}]+\}/,
  /\{\{[^}]+\}\}/,
];

// ── Pure helpers ──────────────────────────────────────────────────────────

function nonEmpty(s: string | null | undefined): boolean {
  return typeof s === "string" && s.trim().length > 0 && s.trim().toLowerCase() !== "unknown";
}

/**
 * Length sweet spot. 3-8 turns is ideal: enough to get the info and
 * deliver the warning, not so long the bot looks like it's stalling.
 */
function lengthScore(turns: number): { earned: number; reason: string } {
  if (turns >= 3 && turns <= 8) return { earned: W_LENGTH, reason: `${turns} turns (ideal range 3-8)` };
  if (turns === 2 || turns === 9) return { earned: 10, reason: `${turns} turns (just outside ideal)` };
  if (turns >= 10 && turns <= 15) return { earned: 5, reason: `${turns} turns (rambled — bot held caller too long)` };
  if (turns === 1) return { earned: 0, reason: `1 turn (caller hung up immediately)` };
  if (turns === 0) return { earned: 0, reason: `no turns recorded` };
  return { earned: 0, reason: `${turns} turns (way out of range)` };
}

function detectPersonaLeak(turns: ConversationTurn[]): { leaked: boolean; quote: string } {
  for (const t of turns) {
    if (t.role !== "bot") continue;
    for (const p of PERSONA_LEAK_PATTERNS) {
      const m = p.exec(t.text);
      if (m) return { leaked: true, quote: m[0] };
    }
  }
  return { leaked: false, quote: "" };
}

function detectQuestionLoop(turns: ConversationTurn[]): boolean {
  // Two consecutive bot turns asking the same question (or near-identical
  // first 30 chars) suggests Sam got stuck.
  let prevBot: string | null = null;
  for (const t of turns) {
    if (t.role !== "bot") continue;
    const head = t.text.trim().slice(0, 30).toLowerCase();
    if (prevBot && head && prevBot === head) return true;
    prevBot = head;
  }
  return false;
}

/**
 * Did the caller hear the warning? Heuristic: the last turn is from the bot
 * AND it contains DNC-warning language. If the last turn is from the caller,
 * they likely hung up before Sam could finish.
 */
function callerHeardWarning(turns: ConversationTurn[]): boolean {
  if (turns.length === 0) return false;
  const last = turns[turns.length - 1];
  if (last.role !== "bot") return false;
  return /(do not call|TCPA|telephone consumer protection|registry|recorded|violation)/i.test(last.text);
}

function lastTurnRole(turns: ConversationTurn[]): "caller" | "bot" | null {
  if (turns.length === 0) return null;
  return turns[turns.length - 1].role;
}

function bandFor(score: number): LetterGrade {
  if (score >= 90) return "A";
  if (score >= 80) return "B";
  if (score >= 70) return "C";
  if (score >= 60) return "D";
  return "F";
}

function clamp(n: number, lo = 0, hi = 100): number {
  return Math.max(lo, Math.min(hi, n));
}

// ── Public API ────────────────────────────────────────────────────────────

export function gradeConversation(call: CallSummaryForGrading): ConversationGrade {
  const factors: GradeFactor[] = [];
  const missingInfo: ConversationGrade["missingInfo"] = [];

  // ── Factor 1: company name ──
  if (nonEmpty(call.companyName)) {
    factors.push({ name: "company_extracted", weight: W_COMPANY, earned: W_COMPANY, reason: `company "${call.companyName}" captured` });
  } else {
    factors.push({ name: "company_extracted", weight: W_COMPANY, earned: 0, reason: "company name NOT captured" });
    missingInfo.push("company");
  }

  // ── Factor 2: caller name ──
  if (nonEmpty(call.callerName)) {
    factors.push({ name: "caller_name_extracted", weight: W_NAME, earned: W_NAME, reason: `caller "${call.callerName}" captured` });
  } else {
    factors.push({ name: "caller_name_extracted", weight: W_NAME, earned: 0, reason: "caller name NOT captured" });
    missingInfo.push("name");
  }

  // ── Factor 3: purpose ──
  if (nonEmpty(call.purpose)) {
    factors.push({ name: "purpose_extracted", weight: W_PURPOSE, earned: W_PURPOSE, reason: "purpose captured" });
  } else {
    factors.push({ name: "purpose_extracted", weight: W_PURPOSE, earned: 0, reason: "purpose NOT captured" });
    missingInfo.push("purpose");
  }

  // ── Factor 4: recording ──
  if (nonEmpty(call.recordingUrl)) {
    factors.push({ name: "recording_present", weight: W_RECORDING, earned: W_RECORDING, reason: "Twilio recording URL on file" });
  } else {
    factors.push({ name: "recording_present", weight: W_RECORDING, earned: 0, reason: "no recording URL (evidence loss)" });
    missingInfo.push("recording");
  }

  // ── Factor 5: conversation length sweet spot ──
  const turnCount = call.turns.length;
  const lenScore = lengthScore(turnCount);
  factors.push({ name: "conversation_length", weight: W_LENGTH, earned: lenScore.earned, reason: lenScore.reason });

  // ── Factor 6: caller heard warning ──
  const heard = callerHeardWarning(call.turns);
  factors.push({
    name: "caller_heard_warning",
    weight: W_HEARD_WARNING,
    earned: heard ? W_HEARD_WARNING : 0,
    reason: heard ? "warning was final bot utterance" : "warning not detected as final utterance",
  });

  // ── Penalty: persona leak ──
  const leak = detectPersonaLeak(call.turns);
  if (leak.leaked) {
    factors.push({ name: "persona_leak", weight: 0, earned: PENALTY_PERSONA_LEAK, reason: `bot leaked "${leak.quote.slice(0, 30)}"` });
  }

  // ── Penalty: stuck loop ──
  if (detectQuestionLoop(call.turns)) {
    factors.push({ name: "stuck_loop", weight: 0, earned: PENALTY_LOOP, reason: "bot repeated same opening twice" });
  }

  const rawScore = factors.reduce((s, f) => s + f.earned, 0);
  const score = clamp(rawScore);

  // Special case: less than 2 turns is INCOMPLETE, not a real grade.
  let grade: LetterGrade = bandFor(score);
  if (turnCount < 2) grade = "INCOMPLETE";

  // Hang-up risk
  let hangUpRisk: HangUpRisk;
  if (turnCount < 2) hangUpRisk = "high";
  else if (heard) hangUpRisk = "low";
  else if (lastTurnRole(call.turns) === "caller") hangUpRisk = "medium";
  else hangUpRisk = "medium";

  // Build summary. "fields" counts the 3 extraction targets (company, name,
  // purpose); recording is reported separately because it's backfilled
  // post-call by the recording-status webhook.
  const summary = (() => {
    if (grade === "INCOMPLETE") return "Call ended before any real exchange (likely caller hung up).";
    const fieldsGot = 3 - missingInfo.filter((m) => m !== "recording").length;
    const recPart = missingInfo.includes("recording") ? "no recording" : "recording captured";
    return `Grade ${grade} (${score}/100) — extracted ${fieldsGot}/3 fields, ${recPart}, ${turnCount} turn(s), hang-up risk ${hangUpRisk}.`;
  })();

  return {
    callSid: call.callSid,
    grade,
    score,
    factors,
    hangUpRisk,
    missingInfo,
    summary,
  };
}

// ── Aggregate helper ──────────────────────────────────────────────────────

export interface AggregateGradeReport {
  totalCalls: number;
  graded: number;
  incomplete: number;
  averageScore: number;       // graded only
  bandCounts: Record<LetterGrade, number>;
  extractionRates: {
    company: number;          // 0..1
    name: number;
    purpose: number;
    recording: number;
  };
  hangUpRiskCounts: Record<HangUpRisk, number>;
}

export function aggregateGrades(grades: ConversationGrade[]): AggregateGradeReport {
  const bandCounts: Record<LetterGrade, number> = { A: 0, B: 0, C: 0, D: 0, F: 0, INCOMPLETE: 0 };
  const hangUpRiskCounts: Record<HangUpRisk, number> = { low: 0, medium: 0, high: 0 };
  let scoreSum = 0;
  let graded = 0;
  let incomplete = 0;
  let companyHits = 0;
  let nameHits = 0;
  let purposeHits = 0;
  let recordingHits = 0;

  for (const g of grades) {
    bandCounts[g.grade]++;
    hangUpRiskCounts[g.hangUpRisk]++;
    if (g.grade === "INCOMPLETE") {
      incomplete++;
    } else {
      graded++;
      scoreSum += g.score;
    }
    if (!g.missingInfo.includes("company")) companyHits++;
    if (!g.missingInfo.includes("name")) nameHits++;
    if (!g.missingInfo.includes("purpose")) purposeHits++;
    if (!g.missingInfo.includes("recording")) recordingHits++;
  }

  const total = grades.length || 1;
  return {
    totalCalls: grades.length,
    graded,
    incomplete,
    averageScore: graded > 0 ? Math.round(scoreSum / graded) : 0,
    bandCounts,
    extractionRates: {
      company: companyHits / total,
      name: nameHits / total,
      purpose: purposeHits / total,
      recording: recordingHits / total,
    },
    hangUpRiskCounts,
  };
}
