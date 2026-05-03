/**
 * demoSeed.ts — Demo-mode seed for the SpamSlayer UI.
 *
 * Creates a realistic, fully-populated offender profile in cases.json so
 * the full end-to-end workflow (case detail, filing package, complaint
 * bundle) can be shown without waiting for real spam calls.
 *
 * Safety properties:
 *   1. The seeded phone number is +1-555-555-0199. Per NANP convention,
 *      555-01XX is reserved for fictional use only (see FCC
 *      https://www.nationalnanpa.com/number_resource_info/555_numbers.html)
 *      — it cannot ring a real subscriber.
 *   2. The subscriberId is "demo-subscriber" — distinct from any real user.
 *   3. The call metadata carries a demoMode: true marker in the offender's
 *      companyName and in every transcriptSnippet ("[DEMO]") so nothing
 *      downstream can mistake a demo record for a real one.
 *   4. The seed is idempotent — calling seedDemoCase() twice updates the
 *      same record rather than piling up duplicates.
 *   5. Deletion is explicit via clearDemoCase() — nothing auto-removes it,
 *      but we log loudly so the user knows it's in their DB.
 *
 * IMPORTANT: This record is ONLY for UI demonstration. Any petition
 * generated from it is clearly marked [DEMO] in the transcripts and
 * should NOT be filed with a court. The complaint-bundle drafts are
 * also marked and should NOT be submitted.
 */

import fs from "fs";
import path from "path";
import type { OffenderProfile, CallEntry } from "./caseBuilder";

const CASES_FILE = path.resolve(__dirname, "../../../cases.json");
const CASES_TEMP = CASES_FILE + ".tmp";

export const DEMO_PHONE = "+15555550199"; // NANP reserved fictional range
export const DEMO_SUBSCRIBER = "demo-subscriber";

function load(): Record<string, OffenderProfile> {
  if (!fs.existsSync(CASES_FILE)) return {};
  try {
    const raw = fs.readFileSync(CASES_FILE, "utf-8");
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return {};
    }
    return parsed as Record<string, OffenderProfile>;
  } catch {
    return {};
  }
}

function save(db: Record<string, OffenderProfile>): void {
  fs.writeFileSync(CASES_TEMP, JSON.stringify(db, null, 2), {
    encoding: "utf-8",
    mode: 0o600,
  });
  try { fs.chmodSync(CASES_TEMP, 0o600); } catch { /* best-effort */ }
  fs.renameSync(CASES_TEMP, CASES_FILE);
  try { fs.chmodSync(CASES_FILE, 0o600); } catch { /* best-effort */ }
}

/**
 * Build a realistic auto-warranty spam campaign: 6 calls spread over
 * ~4 months, with recordings, transcripts, and a company name drawn
 * out of the caller. Damage math: 6 × $500 = $3,000 base under § 227(b).
 * One call is placed outside DNC hours (7:15 AM) so the DNC-hour signal
 * fires in the research report.
 */
function makeDemoCalls(): CallEntry[] {
  return [
    {
      date: "2026-01-07",
      time: "10:42",
      callSid: "DEMO_CALL_001",
      subscriberId: DEMO_SUBSCRIBER,
      recordingUrl: "https://example.invalid/demo-recording-001.mp3",
      transcriptSnippet:
        "[DEMO] This is your final notice regarding your vehicle's extended warranty. " +
        "Press 1 now to speak with a specialist about lowering your rate.",
      callType: "robocall",
    },
    {
      date: "2026-01-19",
      time: "14:08",
      callSid: "DEMO_CALL_002",
      subscriberId: DEMO_SUBSCRIBER,
      recordingUrl: "https://example.invalid/demo-recording-002.mp3",
      transcriptSnippet:
        "[DEMO] Hi, this is Mike from Preferred Auto Protection. I'm calling about " +
        "the warranty on your vehicle. Can I confirm your year and make?",
      callType: "robocall",
    },
    {
      date: "2026-02-03",
      time: "07:15", // outside 8AM-9PM calling-hours window (47 C.F.R. Part 64 Subpart L)
      callSid: "DEMO_CALL_003",
      subscriberId: DEMO_SUBSCRIBER,
      recordingUrl: "https://example.invalid/demo-recording-003.mp3",
      transcriptSnippet:
        "[DEMO] Good morning, this is Preferred Auto Protection calling about your " +
        "vehicle warranty which is about to expire. Press 1 to renew.",
      callType: "robocall",
    },
    {
      date: "2026-02-21",
      time: "11:30",
      callSid: "DEMO_CALL_004",
      subscriberId: DEMO_SUBSCRIBER,
      recordingUrl: "https://example.invalid/demo-recording-004.mp3",
      transcriptSnippet:
        "[DEMO] This is Jessica with Preferred Auto Protection. Our records show you " +
        "haven't renewed your vehicle service contract. Please call us back at this number.",
      callType: "robocall",
    },
    {
      date: "2026-03-14",
      time: "09:55",
      callSid: "DEMO_CALL_005",
      subscriberId: DEMO_SUBSCRIBER,
      recordingUrl: "https://example.invalid/demo-recording-005.mp3",
      transcriptSnippet:
        "[DEMO] Final warning — your auto warranty coverage will lapse unless you call " +
        "Preferred Auto Protection at the callback number. Press 1 to speak with an agent.",
      callType: "robocall",
    },
    {
      date: "2026-04-09",
      time: "15:22",
      callSid: "DEMO_CALL_006",
      subscriberId: DEMO_SUBSCRIBER,
      recordingUrl: "https://example.invalid/demo-recording-006.mp3",
      transcriptSnippet:
        "[DEMO] This is Mike from Preferred Auto Protection calling for one last time " +
        "about the extended warranty on your vehicle. Press 1 or call us back.",
      callType: "robocall",
    },
  ];
}

export function buildDemoOffender(): OffenderProfile {
  const calls = makeDemoCalls();
  // Damages: 6 calls × $500 per § 227(b)(3)(B) minimum. Not trebled —
  // we're showing a conservative non-willful scenario.
  const damagesEstimate = calls.length * 500;

  return {
    normalizedNumber: DEMO_PHONE,
    rawNumbers: ["(555) 555-0199", "555-555-0199"],
    companyName: "Preferred Auto Protection [DEMO]",
    callerNames: ["Mike", "Jessica"],
    purpose: "Auto warranty extension solicitation (robocall campaign)",
    callCount: calls.length,
    calls,
    firstCallDate: calls[0].date,
    lastCallDate: calls[calls.length - 1].date,
    actionable: true,
    willful: false,
    damagesEstimate,
    demandLetterSent: false,
    demandLetterDate: null,
    subscriberIds: [DEMO_SUBSCRIBER],
    filedAt: null,
    filedCaseRef: null,
  };
}

/**
 * Insert or refresh the demo offender in cases.json. Idempotent — if the
 * demo record already exists, it is overwritten in place so the demo
 * always shows the same deterministic state.
 */
export function seedDemoCase(): { created: boolean; offender: OffenderProfile } {
  const db = load();
  const exists = Boolean(db[DEMO_PHONE]);
  const offender = buildDemoOffender();
  db[DEMO_PHONE] = offender;
  save(db);
  console.log(
    `[DemoSeed] ${exists ? "Refreshed" : "Created"} demo offender ${DEMO_PHONE} ` +
    `(${offender.callCount} calls, $${offender.damagesEstimate} damages).`
  );
  return { created: !exists, offender };
}

/**
 * Remove the demo offender. Does NOT touch any other offender record.
 */
export function clearDemoCase(): { removed: boolean } {
  const db = load();
  if (!db[DEMO_PHONE]) return { removed: false };
  delete db[DEMO_PHONE];
  save(db);
  console.log(`[DemoSeed] Removed demo offender ${DEMO_PHONE}.`);
  return { removed: true };
}

export function isDemoOffender(normalizedNumber: string): boolean {
  return normalizedNumber === DEMO_PHONE;
}

/**
 * Demo-safe config overrides so the filing/complaint endpoints can render
 * a package for the demo phone even when the real user hasn't completed
 * Settings → Legal yet. Every field is clearly fake and labeled [DEMO].
 *
 * Never use these for a real offender — they would produce a non-filable
 * petition (Jane Demo is not the real filer).
 */
export const DEMO_FILING_OVERRIDES = {
  userName: "Jane Demo [DEMO PLAINTIFF]",
  userAddress: "123 Demo Lane",
  userCity: "Lafayette",
  userState: "LA",
  userZip: "70501",
  userPhone: "+13375550100",
  userEmail: "demo@example.invalid",
  dncRegistrationDate: "2020-06-15",
  lineType: "residential" as const,
};
