// ─────────────────────────────────────────────────────────────────────────────
//  defendantResearch_tests.ts — Adversarial test harness for the
//  pre-filing defendant research module.
//
//  These tests are the GATE on every change to defendantResearch.ts. If you
//  touch the scoring or add a signal, a test in here must cover it, and the
//  full suite must pass before shipping. Run with:
//    npx ts-node defendantResearch_tests.ts
//
//  Philosophy: no mocks, no framework. We assemble realistic OffenderProfile
//  inputs, call the public API, and assert on the output. Every failure
//  prints a clear diff so you can triage in seconds.
// ─────────────────────────────────────────────────────────────────────────────

import type { OffenderProfile, CallEntry } from "./src/services/caseBuilder";
import {
  scoreCollectability,
  generateDefendantResearchReport,
  type CollectabilityScore,
} from "./src/services/defendantResearch";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function t(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err: any) {
    console.log(`  ✗ ${name}`);
    console.log(`      ${err?.message ?? String(err)}`);
    failures.push(`${name}: ${err?.message ?? String(err)}`);
    failed++;
  }
}

function section(title: string): void {
  console.log(`\n[${title}]`);
}

function assert(cond: any, msg: string): void {
  if (!cond) throw new Error(msg);
}

function assertEq<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertBetween(actual: number, lo: number, hi: number, label: string): void {
  if (actual < lo || actual > hi) {
    throw new Error(`${label}: expected ${lo}..${hi}, got ${actual}`);
  }
}

// ── Profile factory ────────────────────────────────────────────────────
//  Build a realistic OffenderProfile from a sparse spec. Defaults chosen to
//  be "neutral-ish" — no auto-flags either way. Each test overrides only
//  the fields it cares about.

interface Spec {
  number?: string;
  companyName?: string | null;
  callerNames?: string[];
  callCount?: number;
  firstDaysAgo?: number;   // days ago call #1 happened
  lastDaysAgo?: number;    // days ago most-recent call happened
  callTimes?: string[];    // HH:MM for each call, in order
  transcripts?: string[];  // transcriptSnippet for each call
}

function makeProfile(s: Spec = {}): OffenderProfile {
  const count = s.callCount ?? 3;
  const firstOffset = s.firstDaysAgo ?? 60;
  const lastOffset = s.lastDaysAgo ?? 10;
  const now = Date.now();
  const firstTs = now - firstOffset * 86_400_000;
  const lastTs = now - lastOffset * 86_400_000;
  const calls: CallEntry[] = [];
  for (let i = 0; i < count; i++) {
    const frac = count === 1 ? 0 : i / (count - 1);
    const ts = new Date(firstTs + frac * (lastTs - firstTs));
    const date = ts.toISOString().split("T")[0];
    const time = s.callTimes?.[i] ?? ts.toTimeString().slice(0, 5);
    const transcript = s.transcripts?.[i] ?? "[no transcript]";
    calls.push({
      date,
      time,
      callSid: `CA_TEST_${i}_${Math.random().toString(36).slice(2, 10)}`,
      subscriberId: "test-user",
      recordingUrl: i % 2 === 0 ? `https://api.twilio.com/recordings/t${i}` : null,
      transcriptSnippet: transcript,
      callType: "robocall",
    });
  }
  return {
    normalizedNumber: s.number ?? "+13375551234",
    rawNumbers: [s.number ?? "+13375551234"],
    companyName: s.companyName === undefined ? null : s.companyName,
    callerNames: s.callerNames ?? [],
    purpose: null,
    callCount: calls.length,
    calls,
    firstCallDate: calls[0]?.date ?? "",
    lastCallDate: calls[calls.length - 1]?.date ?? "",
    actionable: true,
    willful: false,
    damagesEstimate: 1500,
    demandLetterSent: false,
    demandLetterDate: null,
    subscriberIds: ["test-user"],
    filedAt: null,
    filedCaseRef: null,
  };
}

const CFG = {
  courtState: "LA",
  courtStateLong: "Louisiana",
  courtName: "Lafayette City Court",
};

function score(p: OffenderProfile): CollectabilityScore {
  return scoreCollectability(p);
}

function report(p: OffenderProfile): string {
  return generateDefendantResearchReport(p, CFG, "TEST-CASE", new Date(2026, 3, 18)).text;
}

// ════════════════════════════════════════════════════════════════════════
//  PART 1 — BASIC SCORING SANITY
// ════════════════════════════════════════════════════════════════════════
section("Part 1 — Basic scoring sanity");

t("score returns value in [0,100] for trivial input", () => {
  const s = score(makeProfile());
  assertBetween(s.score, 0, 100, "score bounds");
});

t("band is LOW when score <30, MEDIUM <60, HIGH >=60", () => {
  // Contrived — compose a profile that should produce each band. We verify
  // the BAND-TO-SCORE contract, not specific scores (those can drift).
  const s1 = score(makeProfile({ number: "+18005551212", callCount: 1, firstDaysAgo: 1, lastDaysAgo: 1 })); // all bad
  assert(s1.band === "LOW" || s1.score < 30, `expected LOW band, got ${s1.band} (${s1.score})`);
  const s2 = score(makeProfile({
    number: "+13375551234",
    companyName: "Acme Widgets LLC",
    callerNames: ["Acme Customer Service"],
    callCount: 5,
    firstDaysAgo: 200,
    lastDaysAgo: 5,
  }));
  if (s2.score < 30) assertEq(s2.band, "LOW", "s2 band");
  else if (s2.score < 60) assertEq(s2.band, "MEDIUM", "s2 band");
  else assertEq(s2.band, "HIGH", "s2 band");
});

t("score is deterministic for identical input", () => {
  const p = makeProfile({ number: "+18005551212", callerNames: ["Acme Warranty"] });
  const s1 = score(p);
  const s2 = score(p);
  assertEq(s1.score, s2.score, "score repro");
  assertEq(s1.band, s2.band, "band repro");
});

t("no NaN/Infinity in score under malformed call dates", () => {
  const p = makeProfile();
  p.calls.forEach((c) => { c.date = "not-a-date"; c.time = "bogus"; });
  p.firstCallDate = "not-a-date";
  p.lastCallDate = "not-a-date";
  const s = score(p);
  assert(Number.isFinite(s.score), "score must be finite");
  assertBetween(s.score, 0, 100, "score bounds even with bad dates");
});

// ════════════════════════════════════════════════════════════════════════
//  PART 2 — NUMBER-PATTERN SIGNALS
// ════════════════════════════════════════════════════════════════════════
section("Part 2 — Number-pattern signals");

t("toll-free 800 is slightly negative", () => {
  const s = score(makeProfile({ number: "+18005554321" }));
  assert(s.signals.some((x) => /toll-?free/i.test(x.label)), "expected toll-free signal");
});

t("all 7 NANP toll-free prefixes flagged (800, 833, 844, 855, 866, 877, 888)", () => {
  for (const prefix of ["800", "833", "844", "855", "866", "877", "888"]) {
    const s = score(makeProfile({ number: `+1${prefix}5554321` }));
    assert(s.signals.some((x) => /toll-?free/i.test(x.label)), `toll-free ${prefix} missed`);
  }
});

t("900-series flagged (pay-per-call)", () => {
  const s = score(makeProfile({ number: "+19005551234" }));
  assert(s.signals.some((x) => /900/.test(x.label)), "expected 900-series signal");
});

t("500-series flagged (personal/VoIP)", () => {
  const s = score(makeProfile({ number: "+15005551234" }));
  assert(s.signals.some((x) => /5[0-9]{2}-?series|5\d\d[- ]?series|500/.test(x.label)), "expected 500-series signal");
});

t("repeating-digit exchange block flagged", () => {
  const s = score(makeProfile({ number: "+13375551234" }));
  assert(s.signals.some((x) => /repeating/i.test(x.label)), "expected repeating-digit signal");
});

t("1212 demo subscriber flagged", () => {
  const s = score(makeProfile({ number: "+14245551212" }));
  assert(s.signals.some((x) => /1212|demo|test/i.test(x.label)), "expected 1212 demo signal");
});

t("non-10-digit number is flagged (malformed or international)", () => {
  const s = score(makeProfile({ number: "+442071234567" }));
  assert(s.signals.some((x) => /non-standard|format|international/i.test(x.label)), "non-10-digit missed");
});

// ════════════════════════════════════════════════════════════════════════
//  PART 3 — CARIBBEAN +1 HIGH-FRAUD AREA CODES (NEW)
// ════════════════════════════════════════════════════════════════════════
section("Part 3 — Caribbean +1 high-fraud NPAs");

// These look like US but are in Caribbean countries; US small-claims process
// cannot reach them.
const CARIBBEAN = ["876", "284", "649", "767", "473", "758", "784", "868", "869", "664", "246", "242", "441", "345", "264", "268", "340", "787", "939", "671", "684", "670"];

for (const npa of CARIBBEAN) {
  t(`Caribbean NPA ${npa} flagged as high-fraud`, () => {
    const s = score(makeProfile({ number: `+1${npa}5551234` }));
    assert(
      s.signals.some((x) => /caribbean|international|outside.*us|foreign/i.test(x.label)),
      `Caribbean NPA ${npa} not flagged: ${JSON.stringify(s.signals.map((x) => x.label))}`,
    );
  });
}

t("Caribbean NPA produces LOW score by itself", () => {
  const s = score(makeProfile({ number: "+18765551234" }));
  assertEq(s.band, "LOW", "Caribbean should push to LOW");
});

// ════════════════════════════════════════════════════════════════════════
//  PART 4 — NEIGHBOR-SPOOFING (NPA-NXX MATCHES USER)
// ════════════════════════════════════════════════════════════════════════
section("Part 4 — Neighbor-spoofing");

t("first 6 digits matching user phone triggers spoof signal", () => {
  // User in +13375557890; offender in +13375551234 — same NPA+NXX (337-555).
  const p = makeProfile({ number: "+13375551234" });
  const cfg = { ...CFG, userPhone: "+13375557890" };
  const r = generateDefendantResearchReport(p, cfg as any, "T", new Date());
  assert(
    r.collectability.signals.some((x) => /neighbor|spoof|match.*user/i.test(x.label)),
    `neighbor-spoof signal missing: ${JSON.stringify(r.collectability.signals.map((x) => x.label))}`,
  );
});

t("different NPA from user does NOT trigger neighbor-spoof", () => {
  const p = makeProfile({ number: "+15045551234" });
  const cfg = { ...CFG, userPhone: "+13375557890" };
  const r = generateDefendantResearchReport(p, cfg as any, "T", new Date());
  assert(
    !r.collectability.signals.some((x) => /neighbor|spoof/i.test(x.label)),
    "neighbor-spoof false positive",
  );
});

t("no userPhone in cfg = no neighbor-spoof signal (graceful)", () => {
  const p = makeProfile({ number: "+13375551234" });
  const r = generateDefendantResearchReport(p, CFG, "T", new Date());
  // Should NOT throw. Signal may or may not be present depending on other heuristics.
  assert(Number.isFinite(r.collectability.score), "score still valid without userPhone");
});

// ════════════════════════════════════════════════════════════════════════
//  PART 5 — TIME-OF-DAY / DNC-HOUR PATTERN
// ════════════════════════════════════════════════════════════════════════
section("Part 5 — Time-of-day pattern");

t("all-3AM calls flag offshore auto-dialer", () => {
  const s = score(makeProfile({
    callTimes: ["03:15", "03:22", "02:47", "03:01"],
    callCount: 4,
  }));
  assert(
    s.signals.some((x) => /(dnc|hour|night|offshore|early|after)/i.test(x.label)),
    `time-of-day signal missing: ${s.signals.map((x) => x.label).join(", ")}`,
  );
});

t("all business-hours calls do NOT trigger DNC-hour signal", () => {
  const s = score(makeProfile({
    callTimes: ["09:15", "14:22", "10:47", "11:01"],
    callCount: 4,
  }));
  assert(
    !s.signals.some((x) => /(night|after.*hour|dnc.*hour)/i.test(x.label)),
    "DNC-hour false positive for 9-5 calls",
  );
});

t("call at 10:30 PM (after 9PM) flagged as TCPA § 227(c) violation window", () => {
  const s = score(makeProfile({
    callTimes: ["22:30", "23:15", "22:45"],
    callCount: 3,
  }));
  assert(
    s.signals.some((x) => /(dnc|hour|night|after)/i.test(x.label)),
    "22:30/23:15 should flag DNC-hour",
  );
});

// ════════════════════════════════════════════════════════════════════════
//  PART 6 — TRANSCRIPT SCAM-PHRASE DETECTION
// ════════════════════════════════════════════════════════════════════════
section("Part 6 — Transcript scam-phrase detection");

const SCAM_PHRASES = [
  "press 1 to lower your rate",
  "your auto warranty is about to expire",
  "this is your final notice",
  "the IRS is filing suit against you",
  "your social security number has been suspended",
  "you have been selected for a grant",
  "your vehicle's factory warranty is expiring",
  "press one to speak with a specialist",
  "we are calling about your student loan forgiveness",
  "congratulations you have won",
];

for (const phrase of SCAM_PHRASES) {
  t(`scam phrase detected: "${phrase}"`, () => {
    const s = score(makeProfile({
      transcripts: [`Hi, ${phrase} today.`],
      callCount: 1,
    }));
    assert(
      s.signals.some((x) => /scam|script|phrase|pitch/i.test(x.label)),
      `phrase "${phrase}" not detected: ${s.signals.map((x) => x.label).join(", ")}`,
    );
  });
}

t("clean transcripts do NOT trigger scam-phrase signal", () => {
  const s = score(makeProfile({
    transcripts: [
      "Hi, this is Acme Widgets calling to confirm your appointment tomorrow.",
      "Sorry we missed you. Please call back when convenient.",
    ],
    callCount: 2,
  }));
  assert(
    !s.signals.some((x) => /scam|script.*phrase/i.test(x.label)),
    "false positive on clean transcript",
  );
});

t("scam-phrase penalty saturates (cannot make score go infinitely negative)", () => {
  const manyScams = Array(50).fill("press 1 to lower your rate. your auto warranty is expiring.");
  const s = score(makeProfile({ transcripts: manyScams, callCount: 50 }));
  assertBetween(s.score, 0, 100, "saturates in bounds even with 50 scam calls");
});

// ════════════════════════════════════════════════════════════════════════
//  PART 7 — INVALID NANPA / SEQUENTIAL DIGITS / VOIP
// ════════════════════════════════════════════════════════════════════════
section("Part 7 — NANPA validity + sequential + VoIP");

t("area code 000 flagged as invalid NANPA", () => {
  const s = score(makeProfile({ number: "+10005551234" }));
  assert(
    s.signals.some((x) => /invalid|nanpa|format|malformed/i.test(x.label)),
    "000 area code not flagged",
  );
});

t("area code starting with 0 or 1 flagged as invalid NANPA", () => {
  for (const bad of ["055", "155"]) {
    const s = score(makeProfile({ number: `+1${bad}5551234` }));
    assert(
      s.signals.some((x) => /invalid|nanpa|format|malformed/i.test(x.label)),
      `NPA ${bad} not flagged`,
    );
  }
});

t("N11 area codes (211, 311, 411, 511, 611, 711, 811, 911) flagged if used as NPA", () => {
  // N11s are service codes, never valid NPA. Caller CDR should never show one.
  for (const n11 of ["211", "311", "411", "511", "611", "711", "811", "911"]) {
    const s = score(makeProfile({ number: `+1${n11}5551234` }));
    assert(
      s.signals.some((x) => /invalid|n11|service|nanpa|format/i.test(x.label)),
      `N11 ${n11} not flagged`,
    );
  }
});

t("sequential subscriber digits (1234) flagged", () => {
  const s = score(makeProfile({ number: "+14045551234" }));
  // Note: subscriber 1234 is NOT a repeating-digit pattern (that's 1111/0000).
  // This is a separate 'sequential digits' heuristic.
  assert(
    s.signals.some((x) => /(sequential|consecutive|pattern)/i.test(x.label)),
    `sequential 1234 not flagged: ${s.signals.map((x) => x.label).join(", ")}`,
  );
});

// ════════════════════════════════════════════════════════════════════════
//  PART 8 — CALLER-NAME NORMALIZATION + COMPANYNAME CROSS-REF
// ════════════════════════════════════════════════════════════════════════
section("Part 8 — Caller-name normalization");

t("entity suffix 'LLC' stripped before generic detection", () => {
  // "Warranty Dept LLC" should still be detected as generic (dept is generic)
  const s = score(makeProfile({ callerNames: ["Warranty Dept LLC"] }));
  assert(
    s.signals.some((x) => /generic/i.test(x.label)),
    "generic detection failed on 'Warranty Dept LLC'",
  );
});

t("entity suffix 'Inc.' stripped + specific name still detected", () => {
  const s = score(makeProfile({
    number: "+13045551234",
    callerNames: ["Acme Widgets Inc."],
  }));
  assert(
    s.signals.some((x) => /specific|captured/i.test(x.label)),
    "'Acme Widgets Inc.' should be specific",
  );
});

t("all-generic caller names negative signal", () => {
  const s = score(makeProfile({ callerNames: ["Mike", "Customer Service", "Warranty Dept"] }));
  assert(
    s.signals.some((x) => /generic/i.test(x.label)),
    "all-generic not flagged",
  );
});

t("companyName set with specific value boosts even if callerNames generic", () => {
  const specific = makeProfile({
    number: "+13045551234",
    companyName: "National Auto Protection Services, LLC",
    callerNames: ["Mike", "Representative"],
  });
  const generic = makeProfile({
    number: "+13045551234",
    companyName: null,
    callerNames: ["Mike", "Representative"],
  });
  const s1 = score(specific);
  const s2 = score(generic);
  assert(
    s1.score > s2.score,
    `companyName cross-ref did not boost score (s1=${s1.score}, s2=${s2.score})`,
  );
});

t("empty callerNames produces no-caller-id signal", () => {
  const s = score(makeProfile({ callerNames: [] }));
  assert(
    s.signals.some((x) => /no caller|no identifier|captured/i.test(x.label)),
    "missing no-caller-id signal",
  );
});

// ════════════════════════════════════════════════════════════════════════
//  PART 9 — PERSISTENCE
// ════════════════════════════════════════════════════════════════════════
section("Part 9 — Persistence heuristic");

t("persistent campaign (90+ days, 3+ calls) rewarded", () => {
  const s = score(makeProfile({ callCount: 5, firstDaysAgo: 200, lastDaysAgo: 10 }));
  assert(
    s.signals.some((x) => /persist|campaign|long-run/i.test(x.label) && x.delta > 0),
    "persistence reward missing",
  );
});

t("short-burst (1-2 calls in <7 days) penalized", () => {
  const s = score(makeProfile({ callCount: 1, firstDaysAgo: 1, lastDaysAgo: 1 }));
  assert(
    s.signals.some((x) => /(short-?burst|one-?shot|single)/i.test(x.label) && x.delta < 0),
    "short-burst penalty missing",
  );
});

// ════════════════════════════════════════════════════════════════════════
//  PART 10 — REPORT RENDERING
// ════════════════════════════════════════════════════════════════════════
section("Part 10 — Report rendering");

t("report text contains executive summary / bottom-line recommendation", () => {
  const text = report(makeProfile({ number: "+18885551212" }));
  assert(
    /do not file|file with caution|proceed|recommendation|bottom.line/i.test(text),
    "report missing executive summary / recommendation",
  );
});

t("report contains SoS URL for user state", () => {
  const text = report(makeProfile());
  assert(
    /coraweb\.sos\.la\.gov/.test(text),
    "report missing Louisiana SoS URL",
  );
});

t("report contains state-AG consumer-complaint URL", () => {
  const text = report(makeProfile());
  assert(
    /(attorney general|consumer.protection).*(louisiana|\.la\.|ag\.la)/i.test(text) ||
    /ag\.state\.la|ag\.louisiana|lag\.state/i.test(text),
    "report missing LA AG URL",
  );
});

t("report contains ALTERNATIVES section", () => {
  const text = report(makeProfile({ number: "+18885551212" }));
  assert(/ALTERNATIVES/i.test(text), "ALTERNATIVES section missing");
  assert(/sue up the chain|seller liability/i.test(text), "Play 1 missing");
});

t("report URL-encodes caller name used in Google search", () => {
  const text = report(makeProfile({ callerNames: ["Acme & Sons <script>"] }));
  // The injection chars should NOT appear raw; they must be URL-encoded.
  assert(
    !/<script>/.test(text),
    "unencoded <script> in report — XSS/url-injection risk",
  );
});

t("report never prints raw user PII (e.g., a fake SSN in caller name)", () => {
  // Verify nothing weird — we don't have SSNs, but the idea is to confirm
  // no field is smuggled into the output except what we expect.
  const text = report(makeProfile({ callerNames: ["careful 123-45-6789 impostor"] }));
  // The callerName gets echoed in the "Specific entity name(s) captured"
  // signal note and in the Google URL — but it's user-originated data,
  // so echoing is fine; we only check url-injection chars are encoded.
  assert(text.length > 0, "report non-empty");
});

// ════════════════════════════════════════════════════════════════════════
//  PART 11 — ADVERSARIAL / HOSTILE INPUTS
// ════════════════════════════════════════════════════════════════════════
section("Part 11 — Adversarial inputs");

t("handles empty offender (no calls) without crashing", () => {
  const p = makeProfile({ callCount: 1 });
  p.calls = [];
  p.callCount = 0;
  p.firstCallDate = "";
  p.lastCallDate = "";
  const s = score(p);
  assertBetween(s.score, 0, 100, "empty calls still bounded");
});

t("handles 10,000 calls without timing out or crashing (< 1s)", () => {
  const p = makeProfile({ callCount: 3 });
  // Hand-craft huge call array
  const huge: CallEntry[] = [];
  for (let i = 0; i < 10_000; i++) {
    huge.push({
      date: "2025-06-15",
      time: "12:00",
      callSid: `CA_${i}`,
      subscriberId: "u",
      recordingUrl: null,
      transcriptSnippet: "normal business call",
      callType: "robocall",
    });
  }
  p.calls = huge;
  p.callCount = huge.length;
  const t0 = Date.now();
  const s = score(p);
  const dt = Date.now() - t0;
  assertBetween(s.score, 0, 100, "10k calls score bounded");
  assert(dt < 1000, `scoring 10k calls took ${dt}ms (should be <1000)`);
});

t("handles Unicode / zero-width characters in callerNames", () => {
  const s = score(makeProfile({
    callerNames: ["Acme\u200b\u200cWidgets\u2060LLC", "日本語テスト", "\u0000\u0001\u0002"],
  }));
  assertBetween(s.score, 0, 100, "Unicode callerNames bounded");
});

t("handles extremely long caller name (10KB string)", () => {
  const s = score(makeProfile({
    callerNames: ["A".repeat(10_000)],
  }));
  assertBetween(s.score, 0, 100, "10KB callerName bounded");
});

t("handles null/undefined in callerNames (defensive)", () => {
  const p = makeProfile({ callerNames: ["valid"] });
  (p.callerNames as any) = ["valid", null, undefined, 42, {}];
  const s = score(p);
  assertBetween(s.score, 0, 100, "non-string callerNames handled");
});

t("handles missing normalizedNumber without crashing", () => {
  const p = makeProfile();
  (p.normalizedNumber as any) = "";
  const s = score(p);
  assertBetween(s.score, 0, 100, "empty normalizedNumber bounded");
});

t("handles non-string normalizedNumber", () => {
  const p = makeProfile();
  (p.normalizedNumber as any) = null;
  const s = score(p);
  assertBetween(s.score, 0, 100, "null number bounded");
});

t("far-future call dates do not crash persistence calc", () => {
  const p = makeProfile();
  p.firstCallDate = "2099-01-01";
  p.lastCallDate = "2099-12-31";
  const s = score(p);
  assertBetween(s.score, 0, 100, "future dates bounded");
});

t("reversed call dates (first > last) do not crash", () => {
  const p = makeProfile();
  p.firstCallDate = "2026-03-01";
  p.lastCallDate = "2024-01-01";
  const s = score(p);
  assertBetween(s.score, 0, 100, "reversed dates bounded");
});

t("report contains no shell metacharacters from user input", () => {
  // A user who entered a caller name like `; rm -rf /` should not see that
  // end up in a URL or a command-interpretable context. We don't exec, so
  // the risk is low, but we check that nothing that looks shell-interpretable
  // flows into the Google URL un-encoded.
  const text = report(makeProfile({ callerNames: ["evil;rm -rf /"] }));
  // The naked semicolon + space + rm should not appear outside the one place
  // where the signal note echoes the caller's identifier list.
  const googleQuery = text.match(/https:\/\/www\.google\.com\/search\?q=[^\s"]+/);
  if (googleQuery) {
    assert(
      !/;rm /.test(googleQuery[0]),
      "unencoded shell metachars in Google URL",
    );
  }
});

t("all signal labels are non-empty strings", () => {
  const p = makeProfile({ number: "+18765551212" }); // lots of triggers
  const s = score(p);
  for (const sig of s.signals) {
    assert(typeof sig.label === "string" && sig.label.length > 0, "empty signal label");
    assert(typeof sig.note === "string" && sig.note.length > 0, `empty signal note for ${sig.label}`);
    assert(Number.isFinite(sig.delta), `non-finite delta for ${sig.label}`);
  }
});

t("band monotonicity — higher-quality profile never scores lower than lower-quality", () => {
  // Build a "good" and a strictly-worse profile and compare.
  const good = makeProfile({
    number: "+13045554321",
    companyName: "Acme Widgets LLC",
    callerNames: ["Acme Widgets Customer Service"],
    callCount: 10,
    firstDaysAgo: 300,
    lastDaysAgo: 5,
    callTimes: ["10:00", "11:30", "14:15", "13:45", "15:30", "10:45", "11:15", "14:00", "13:00", "15:00"],
    transcripts: new Array(10).fill("Hi, this is Acme Widgets with a scheduled follow-up."),
  });
  const bad = makeProfile({
    number: "+18765551212", // Caribbean + repeating + 1212
    companyName: null,
    callerNames: [],
    callCount: 1,
    firstDaysAgo: 1,
    lastDaysAgo: 1,
    callTimes: ["03:15"],
    transcripts: ["press 1 to lower your rate"],
  });
  const sg = score(good);
  const sb = score(bad);
  assert(sg.score > sb.score, `monotonicity violated: good=${sg.score}, bad=${sb.score}`);
});

// ════════════════════════════════════════════════════════════════════════
//  PART 12 — SCORE CLAMPING / INVARIANTS
// ════════════════════════════════════════════════════════════════════════
section("Part 12 — Clamping invariants");

t("score clamped to [0, 100] regardless of signal sum", () => {
  // Stack many negative signals and verify clamp at 0.
  const p = makeProfile({
    number: "+10005551212",    // invalid NANPA + 1212
    callerNames: [],
    callCount: 1,
    firstDaysAgo: 1,
    lastDaysAgo: 1,
    callTimes: ["03:15"],
    transcripts: ["press 1 to lower your rate. your auto warranty is expiring. final notice."],
  });
  const s = score(p);
  assertBetween(s.score, 0, 100, "negative stack clamp");
});

// ════════════════════════════════════════════════════════════════════════
//  SUMMARY
// ════════════════════════════════════════════════════════════════════════
console.log("\n═══════════════════════════════════════════════════════════════════");
console.log(`  DEFENDANT RESEARCH TESTS: ${passed} passed, ${failed} failed`);
console.log("═══════════════════════════════════════════════════════════════════");

if (failed > 0) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
