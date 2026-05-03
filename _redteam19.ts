// R19-M RED TEAM — adversarial inputs that were NOT in the test suite.
// If ANY of these crash, hang, produce non-deterministic output, or leak
// injection chars into the rendered report, that's a live bug.

import {
  generateDefendantResearchReport,
  scoreCollectability,
  ResearchConfig,
} from "./src/services/defendantResearch";

let passed = 0;
let failed = 0;

function run(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e: any) {
    console.log(`  ✗ ${name}`);
    console.log(`      ${e?.message || e}`);
    failed++;
  }
}

function baseCfg(over: Partial<ResearchConfig> = {}): ResearchConfig {
  return {
    courtState: "LA",
    courtStateLong: "Louisiana",
    courtName: "Lafayette City Court",
    userPhone: "+13375550000",
    ...over,
  };
}

function report(off: any, cfg: ResearchConfig = baseCfg()): string {
  return generateDefendantResearchReport(off, cfg, "CASE-001", new Date("2026-04-18T00:00:00Z")).text;
}

function makeOff(over: any = {}) {
  return {
    normalizedNumber: "+18005551212",
    rawNumbers: ["+18005551212"],
    companyName: null,
    callerNames: ["Bob"],
    purpose: null,
    callCount: 1,
    calls: [
      { date: "2026-01-01", time: "12:00", callSid: "x", subscriberId: "s",
        recordingUrl: null, transcriptSnippet: null, callType: "robocall" },
    ],
    firstCallDate: "2026-01-01",
    lastCallDate: "2026-01-01",
    actionable: true,
    willful: false,
    damagesEstimate: 500,
    demandLetterSent: false,
    demandLetterDate: null,
    subscriberIds: ["s"],
    filedAt: null,
    filedCaseRef: null,
    ...over,
  };
}

console.log("═══════════════════════════════════════════════════════════════════");
console.log("  R19-M RED-TEAM — adversarial pass against defendantResearch");
console.log("═══════════════════════════════════════════════════════════════════");

// 1. Prototype-pollution shaped input
run("prototype-pollution shaped offender doesn't poison globals", () => {
  const hostile = makeOff({ __proto__: { polluted: true } });
  scoreCollectability(hostile as any);
  if (({} as any).polluted) throw new Error("prototype pollution leaked");
});

// 2. Array-masquerading-as-string
run("array passed as callerNames element", () => {
  const r = scoreCollectability(makeOff({ callerNames: [["nested", "array"]] }) as any);
  if (typeof r.score !== "number") throw new Error("score corrupted");
});

// 3. Object-as-string in companyName
run("object passed as companyName", () => {
  const r = scoreCollectability(makeOff({ companyName: { evil: "obj" } }) as any);
  if (typeof r.score !== "number") throw new Error("score corrupted");
});

// 4. NaN propagation in delta math
run("NaN/Infinity signals don't leak into final score", () => {
  const r = scoreCollectability(makeOff({}));
  if (!Number.isFinite(r.score)) throw new Error(`non-finite score: ${r.score}`);
});

// 5. Unicode RTL + combining chars in company name (bidi attack)
run("RTL override char in companyName is stripped or handled", () => {
  const hostile = makeOff({ companyName: "Good\u202eevil" });
  const text = report(hostile);
  if (/\u202e/.test(text)) throw new Error("RTL override char leaked to report");
});

// 6. Emoji in phone number
run("emoji-laden phone number doesn't crash", () => {
  const hostile = makeOff({ normalizedNumber: "+180055512\ud83d\ude0012" });
  report(hostile);
});

// 7. Extremely long call array (100K)
run("100,000-call offender scores in < 3s", () => {
  const calls = Array.from({ length: 100000 }, (_, i) => ({
    date: "2025-01-01", time: "10:00", callSid: `c${i}`, subscriberId: "s",
    recordingUrl: null, transcriptSnippet: null, callType: "robocall",
  }));
  const start = Date.now();
  scoreCollectability(makeOff({ callCount: calls.length, calls }));
  const ms = Date.now() - start;
  if (ms > 3000) throw new Error(`took ${ms}ms (> 3s)`);
});

// 8. Only calls with invalid dates
run("calls with all-invalid date strings don't NaN the span", () => {
  const calls = [
    { date: "not-a-date", time: "xx:xx", callSid: "c1", subscriberId: "s",
      recordingUrl: null, transcriptSnippet: null, callType: "robocall" },
    { date: "also-bad", time: "yy:yy", callSid: "c2", subscriberId: "s",
      recordingUrl: null, transcriptSnippet: null, callType: "robocall" },
  ];
  const r = scoreCollectability(makeOff({ calls, firstCallDate: "not-a-date", lastCallDate: "also-bad" }));
  if (!Number.isFinite(r.score)) throw new Error(`non-finite score with bad dates`);
});

// 9. userPhone with unusual format
run("userPhone with letters or unusual format doesn't crash spoof check", () => {
  report(
    makeOff({ normalizedNumber: "+13375555555" }),
    baseCfg({ userPhone: "(337) 555-5555 ext. 42" }),
  );
});

// 10. Missing courtState entirely
run("missing courtState doesn't crash stateLinks", () => {
  const cfg = baseCfg();
  delete (cfg as any).courtState;
  const text = report(makeOff(), cfg);
  if (text.length === 0) throw new Error("empty report");
});

// 11. courtState in lowercase vs uppercase
run("lowercase courtState 'la' matches same as 'LA'", () => {
  const text1 = report(makeOff(), baseCfg({ courtState: "la" }));
  const text2 = report(makeOff(), baseCfg({ courtState: "LA" }));
  if (/UNKNOWN STATE|unknown state/.test(text1) && !/UNKNOWN STATE|unknown state/.test(text2)) {
    throw new Error("case-sensitivity leaks: lowercase 'la' is treated as unknown");
  }
});

// 12. Determinism
run("same input produces same score 100 times in a row", () => {
  const o = makeOff();
  const first = scoreCollectability(o).score;
  for (let i = 0; i < 100; i++) {
    if (scoreCollectability(o).score !== first) {
      throw new Error(`non-deterministic: iter ${i} got different score`);
    }
  }
});

// 13. NPA with stripped leading zero (+10888555121 = invalid)
run("NPA with stripped leading zero handled without crash", () => {
  scoreCollectability(makeOff({ normalizedNumber: "+10888555121" }));
});

// 14. Injection via normalizedNumber
run("normalizedNumber containing shell/SQL metacharacters is stripped in report", () => {
  const evil = "+18005551212; DROP TABLE cases; --";
  const text = report(makeOff({ normalizedNumber: evil }));
  if (/DROP TABLE|--\s*\n/.test(text)) {
    throw new Error("SQL injection metachars leaked into report");
  }
});

// 15. Null prototype offender
run("Object.create(null) offender has defensive property access", () => {
  const o = Object.create(null);
  Object.assign(o, makeOff());
  scoreCollectability(o);
});

// 16. Every transcript is just the word "yes"
run("repetitive harmless transcript doesn't trigger false scam phrase", () => {
  const calls = Array.from({ length: 5 }, (_, i) => ({
    date: "2025-01-01", time: "10:00", callSid: `c${i}`, subscriberId: "s",
    recordingUrl: null, transcriptSnippet: "yes yes yes yes yes", callType: "robocall",
  }));
  const r = scoreCollectability(makeOff({ calls, callCount: 5 }));
  const scam = r.signals.find((s) => /scam-script/i.test(s.label));
  if (scam) throw new Error(`false-positive scam match: ${scam.label}`);
});

// 17. Case-sensitivity in scam phrases (upper/lower/mixed)
run("scam phrase is matched regardless of transcript case", () => {
  const calls = [{
    date: "2025-01-01", time: "10:00", callSid: "c1", subscriberId: "s",
    recordingUrl: null,
    transcriptSnippet: "PRESS 1 TO LOWER YOUR RATE",
    callType: "robocall",
  }];
  const r = scoreCollectability(makeOff({ calls, callCount: 1 }));
  const scam = r.signals.find((s) => /scam-script/i.test(s.label));
  if (!scam) throw new Error("uppercase scam phrase missed");
});

// 18. companyName = empty string ""
run("empty-string companyName doesn't trigger 'specific companyName' reward", () => {
  const r = scoreCollectability(makeOff({ companyName: "" }));
  const boost = r.signals.find((s) => /specific companyName/i.test(s.label));
  if (boost) throw new Error("empty-string companyName incorrectly rewarded");
});

// 19. Huge number of signals (should not overflow display)
run("report with max possible signals renders without truncation", () => {
  const hostile = makeOff({
    normalizedNumber: "+18765550000",   // Caribbean (Jamaica)
    callerNames: [],
    companyName: null,
    calls: Array.from({ length: 30 }, (_, i) => ({
      date: "2025-01-01", time: "03:00", callSid: `c${i}`, subscriberId: "1234",
      recordingUrl: null,
      transcriptSnippet: "press 1 to lower your rate auto warranty IRS SSN grant student loan",
      callType: "robocall",
    })),
    callCount: 30,
    firstCallDate: "2025-01-01",
    lastCallDate: "2025-01-01",
  });
  const text = report(hostile);
  if (text.length < 500) throw new Error("report too short");
});

// 20. Verify the FILE / CAUTION / DO NOT FILE recommendation is always one of 3
run("recommendation is always one of the 3 canonical strings", () => {
  const variants = [
    makeOff({ normalizedNumber: "+18765551212" }),
    makeOff({ normalizedNumber: "+13375550042", callerNames: ["Real Co, LLC"], companyName: "Real Co, LLC" }),
    makeOff({ normalizedNumber: "+13375550042", callerNames: ["Real Co, LLC"], companyName: "Real Co, LLC", calls: [
      { date: "2025-01-01", time: "10:00", callSid: "c1", subscriberId: "s",
        recordingUrl: null, transcriptSnippet: null, callType: "robocall" },
      { date: "2025-06-01", time: "10:00", callSid: "c2", subscriberId: "s",
        recordingUrl: null, transcriptSnippet: null, callType: "robocall" },
      { date: "2025-12-01", time: "10:00", callSid: "c3", subscriberId: "s",
        recordingUrl: null, transcriptSnippet: null, callType: "robocall" },
    ], firstCallDate: "2025-01-01", lastCallDate: "2025-12-01", callCount: 3 }),
  ];
  for (const v of variants) {
    const text = report(v);
    if (!/(DO NOT FILE|PROCEED WITH CAUTION|FILE)/i.test(text)) {
      throw new Error(`missing recommendation in ${v.normalizedNumber}`);
    }
  }
});

console.log("");
console.log(`RED-TEAM: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
