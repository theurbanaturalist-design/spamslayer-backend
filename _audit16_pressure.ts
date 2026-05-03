// AUDIT_ROUND_16 — Pressure tests that try to BREAK the filing generator.
// Writes OffenderProfile objects directly to cases.json (bypassing logCall's
// real-time Date.now() stamps) so we can precisely position calls in time
// and stress the generator with hostile inputs.
//
// Run:  cd backend && npx ts-node _audit16_pressure.ts

import * as CaseBuilder from "./src/services/caseBuilder";
import { generateFilingPackage } from "./src/services/legalFilingGenerator";
import fs from "fs";
import path from "path";

const CASES_PATH = path.resolve(__dirname, "..", "cases.json");
const PHONE_PATH = path.resolve(__dirname, "..", "phone.json");

interface TestResult {
  id: string;
  title: string;
  bug: string | null;
}
const results: TestResult[] = [];
function record(id: string, title: string, bug: string | null) {
  results.push({ id, title, bug });
  console.log(`  ${bug ? "❌ BROKE" : "✓ held "}  ${id}: ${title}`);
  if (bug) console.log(`      → ${bug}`);
}

// Build a fully-formed OffenderProfile and write it directly into cases.json.
function seedOffender(opts: {
  phone: string;
  companyName: string | null;
  callerName: string | null;
  purpose: string | null;
  numCalls: number;
  oldestCallDaysAgo: number;
  hasRecording?: boolean;
  callType?: string;
}): string {
  const key = CaseBuilder.normalizePhone(opts.phone);
  const calls: any[] = [];
  for (let i = 0; i < opts.numCalls; i++) {
    // Spread calls evenly between `oldestCallDaysAgo` and 1 day ago.
    const span = Math.max(1, opts.oldestCallDaysAgo - 1);
    const daysAgo = opts.numCalls === 1
      ? opts.oldestCallDaysAgo
      : opts.oldestCallDaysAgo - Math.floor((i / (opts.numCalls - 1)) * span);
    const ts = new Date(Date.now() - daysAgo * 86400 * 1000);
    calls.push({
      date: ts.toISOString().split("T")[0],
      time: ts.toTimeString().slice(0, 5),
      callSid: `CA_AUDIT16_${i}_${Date.now()}`,
      subscriberId: "test",
      recordingUrl: opts.hasRecording ? `https://api.twilio.com/recordings/test_${i}` : null,
      transcriptSnippet: `Test transcript snippet ${i}`,
      callType: opts.callType ?? "robocall",
    });
  }
  calls.sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));

  const profile = {
    normalizedNumber: key,
    rawNumbers: [opts.phone],
    companyName: opts.companyName,
    callerNames: opts.callerName ? [opts.callerName] : [],
    purpose: opts.purpose,
    callCount: opts.numCalls,
    calls,
    firstCallDate: calls[0].date,
    lastCallDate: calls[calls.length - 1].date,
    actionable: opts.numCalls >= 2,
    willful: false,
    damagesEstimate: opts.numCalls * 500,
    demandLetterSent: false,
    demandLetterDate: null,
    subscriberIds: ["test"],
    filedAt: null,
    filedCaseRef: null,
  };

  const db = JSON.parse(fs.readFileSync(CASES_PATH, "utf-8"));
  db[key] = profile;
  fs.writeFileSync(CASES_PATH, JSON.stringify(db, null, 2));
  return key;
}

function cleanupOffender(key: string) {
  try {
    const db = JSON.parse(fs.readFileSync(CASES_PATH, "utf-8"));
    delete db[key];
    delete db[`${key}#post-filed`];
    fs.writeFileSync(CASES_PATH, JSON.stringify(db, null, 2));
  } catch {}
}

// ── phone.json setup/restore ─────────────────────────────────────────────
let originalPhoneJson: string | null = null;
try { originalPhoneJson = fs.readFileSync(PHONE_PATH, "utf-8"); } catch {}

const testFilingConfig = {
  userName: "Test Plaintiff",
  userAddress: "123 Test Ave",
  userCity: "Lafayette",
  userState: "LA",
  userZip: "70501",
  userPhone: "+13375550123",
  userEmail: "test@example.com",
  courtName: "Lafayette City Court",
  courtAddress: "800 S. Buchanan Street",
  courtCity: "Lafayette",
  courtState: "LA",
  courtZip: "70501",
  courtClerkPhone: "(337) 291-8760",
  parishOrCounty: "Lafayette Parish",
  dncRegistrationDate: "2015-06-01",
  filingFee: "$75.00",
  serviceFee: "$25.00",
  stateDncStatute: "La. R.S. 45:844.14",
  stateRecordingLaw: "La. R.S. 15:1303 (one-party consent)",
  smallClaimsLimit: "$5,000",
  smallClaimsStatute: "La. R.S. 13:5200 et seq.",
  lineType: "residential",
};
function writeTestPhoneJson() {
  const base = originalPhoneJson ? JSON.parse(originalPhoneJson) : {};
  base.filingConfig = testFilingConfig;
  fs.writeFileSync(PHONE_PATH, JSON.stringify(base, null, 2));
}
function restorePhoneJson() {
  if (originalPhoneJson !== null) fs.writeFileSync(PHONE_PATH, originalPhoneJson);
}

// ── Run tests ────────────────────────────────────────────────────────────

console.log("\n═══ AUDIT_ROUND_16 pressure tests ═══\n");
writeTestPhoneJson();
const keys: string[] = [];

// PT1 — bidi/zero-width in company name
try {
  const evil = "Legit Corp \u202E\u200B gnidnetnoc-scam \u2066";
  const k = seedOffender({ phone: "+15550000001", companyName: evil, callerName: "Agent", purpose: "Warranty pitch", numCalls: 3, oldestCallDaysAgo: 30, hasRecording: true });
  keys.push(k);
  const pkg = generateFilingPackage(k);
  const text = (pkg?.petition ?? "") + (pkg?.exhibitList ?? "") + (pkg?.certificateOfService ?? "");
  const survived = /[\u202A-\u202E\u2066-\u2069\u200B-\u200F]/.test(text);
  record("PT1", "bidi-override / zero-width in companyName", !pkg ? "generator returned null" : survived ? "bidi/zero-width chars made it into sworn text — can silently reverse visible text in court documents" : null);
} catch (e) {
  record("PT1", "bidi-override / zero-width in companyName", `threw: ${(e as Error).message.slice(0, 160)}`);
}

// PT2 — self-suit (offender == userPhone)
try {
  const k = seedOffender({ phone: "+13375550123", companyName: "Me, Inc.", callerName: "Myself", purpose: "Self call", numCalls: 3, oldestCallDaysAgo: 30, hasRecording: true });
  keys.push(k);
  const pkg = generateFilingPackage(k);
  record("PT2", "self-suit (offender == userPhone)", pkg ? `generator accepted filing against user's own number; case ${pkg.caseNumber}. Rule 11 hazard.` : null);
} catch (e) {
  const m = (e as Error).message;
  record("PT2", "self-suit (offender == userPhone)", /self|own number|user.*phone/i.test(m) ? null : `unexpected throw: ${m.slice(0, 160)}`);
}

// PT3 — SOL edge (all calls >4 years old)
try {
  const k = seedOffender({ phone: "+15550000003", companyName: "Stale Claim LLC", callerName: "Old", purpose: "Ancient", numCalls: 3, oldestCallDaysAgo: 4 * 365 + 5, hasRecording: true });
  keys.push(k);
  const pkg = generateFilingPackage(k);
  if (!pkg) {
    record("PT3", "SOL-expired calls", null);
  } else {
    const blocking = pkg.warnings.some((w) => /statute.*limitations|SOL|BLOCKING/i.test(w));
    record("PT3", "SOL-expired calls", blocking ? null : "petition produced for SOL-expired calls with no BLOCKING warning");
  }
} catch (e) {
  const m = (e as Error).message;
  record("PT3", "SOL-expired calls", /SOL|limitations/i.test(m) ? null : `unexpected throw: ${m.slice(0, 160)}`);
}

// PT4 — 10KB company name
try {
  const huge = "EvilCorp ".repeat(1200);
  const k = seedOffender({ phone: "+15550000004", companyName: huge, callerName: "Spammer", purpose: "Stuff", numCalls: 3, oldestCallDaysAgo: 60, hasRecording: true });
  keys.push(k);
  const pkg = generateFilingPackage(k);
  if (!pkg) {
    record("PT4", "10KB company name", "generator returned null");
  } else {
    const occurrences = (pkg.petition.match(/EvilCorp/g) ?? []).length;
    record("PT4", "10KB company name", occurrences > 100 ? `no length cap — companyName appeared ${occurrences}× (>10KB) in petition; will destroy formatting when the court prints it` : null);
  }
} catch (e) {
  record("PT4", "10KB company name", `threw: ${(e as Error).message.slice(0, 160)}`);
}

// PT5 — DNC date year-only
try {
  const k = seedOffender({ phone: "+15550000005", companyName: "NoisyCorp", callerName: "Agent", purpose: "Solar", numCalls: 3, oldestCallDaysAgo: 30, hasRecording: true });
  keys.push(k);
  const pkg = generateFilingPackage(k, { dncRegistrationDate: "2007" });
  if (!pkg) {
    record("PT5", "DNC date year-only", null);
  } else {
    // If the sworn verification paragraph writes the year-only string, a
    // defendant can impeach the § 227(c)(5) 31-day-prior-notice element.
    const mentions = (pkg.petition.match(/\b2007\b/g) ?? []).length;
    record("PT5", "DNC date year-only", mentions > 0 ? `generator wrote bare year 2007 into sworn text ${mentions}×; § 227(c)(5) 31-day window unprovable` : null);
  }
} catch (e) {
  const m = (e as Error).message;
  record("PT5", "DNC date year-only", /date|YYYY-MM-DD|dnc.*format/i.test(m) ? null : `unexpected throw: ${m.slice(0, 160)}`);
}

// ── Cleanup + summary ────────────────────────────────────────────────────
for (const k of keys) cleanupOffender(k);
restorePhoneJson();

console.log("\n═══ PRESSURE TEST SUMMARY ═══");
const broke = results.filter((r) => r.bug);
console.log(`${broke.length}/${results.length} broke the generator.\n`);
for (const r of broke) console.log(`  ${r.id}: ${r.title}\n      → ${r.bug}\n`);
process.exit(broke.length > 0 ? 1 : 0);
