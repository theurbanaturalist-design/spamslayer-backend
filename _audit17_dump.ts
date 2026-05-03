// AUDIT_ROUND_17 — Dump a canonical filing package to /tmp/audit17/ so a
// human (or a lawyer-simulating reviewer) can read every page end-to-end.
// No tests, no assertions — we just want the four documents on disk.

import * as CaseBuilder from "./src/services/caseBuilder";
import { generateFilingPackage } from "./src/services/legalFilingGenerator";
import fs from "fs";
import path from "path";

const CASES_PATH = path.resolve(__dirname, "..", "cases.json");
const PHONE_PATH = path.resolve(__dirname, "..", "phone.json");
const OUT_DIR = "/tmp/audit17";
fs.mkdirSync(OUT_DIR, { recursive: true });

// Save originals so we don't clobber the user's real data.
let origCases: string | null = null;
let origPhone: string | null = null;
try { origCases = fs.readFileSync(CASES_PATH, "utf-8"); } catch {}
try { origPhone = fs.readFileSync(PHONE_PATH, "utf-8"); } catch {}

const testConfig = {
  userName: "Marcus A. Plaintiff",
  userAddress: "1234 Magnolia Lane",
  userCity: "Lafayette",
  userState: "LA",
  userZip: "70503",
  userPhone: "+13375557890",
  userEmail: "marcus@example.com",
  courtName: "Lafayette City Court, Small Claims Division",
  courtAddress: "800 S. Buchanan Street",
  courtCity: "Lafayette",
  courtState: "LA",
  courtZip: "70501",
  courtClerkPhone: "(337) 291-8760",
  parishOrCounty: "Lafayette Parish",
  dncRegistrationDate: "2016-08-14",
  filingFee: "$75.00",
  serviceFee: "$25.00",
  stateDncStatute: "La. R.S. 45:844.14",
  stateRecordingLaw: "La. R.S. 15:1303 (one-party consent)",
  smallClaimsLimit: "$5,000",
  smallClaimsStatute: "La. R.S. 13:5200 et seq.",
  lineType: "residential",
};

// Seed a realistic 6-call case spread over 9 months with a demand letter
// midway through, so the petition exercises the split-damages path and
// the "willful" section.
const phone = "+18885551212";
const key = CaseBuilder.normalizePhone(phone);
const now = Date.now();
const calls: any[] = [];
const offsets = [270, 230, 180, 140, 65, 20]; // days ago
for (let i = 0; i < offsets.length; i++) {
  const ts = new Date(now - offsets[i] * 86400 * 1000);
  calls.push({
    date: ts.toISOString().split("T")[0],
    time: ts.toTimeString().slice(0, 5),
    callSid: `CA_AUDIT17_${i}_${Math.random().toString(36).slice(2, 10)}`,
    subscriberId: "test",
    recordingUrl: i % 2 === 0 ? `https://api.twilio.com/recordings/audit17_${i}` : null,
    transcriptSnippet:
      i === 0
        ? "Hi, this is your extended auto warranty specialist. Press 1 to lower your rate."
        : i === 2
          ? "We are calling one final time about your vehicle's factory warranty expiring."
          : i === 4
            ? "This is a pre-recorded message about solar panels for your home."
            : "[no recording — inbound call registered by carrier CDR only]",
    callType: "robocall",
  });
}
calls.sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));

// Demand letter was sent 100 days ago — so the two calls at 65 and 20
// days ago should be willful-rate ($1,500 each) and the other four at
// $500 each.  4*500 + 2*1500 = $5,000 exactly at the small-claims cap.
const demandLetterDate = new Date(now - 100 * 86400 * 1000)
  .toISOString().split("T")[0];

const profile = {
  normalizedNumber: key,
  rawNumbers: [phone],
  companyName: "National Auto Protection Services, LLC",
  callerNames: ["Mike", "Sarah", "Auto Warranty Dept"],
  purpose: "Solicitation of extended vehicle service contracts",
  callCount: calls.length,
  calls,
  firstCallDate: calls[0].date,
  lastCallDate: calls[calls.length - 1].date,
  actionable: true,
  willful: true,
  damagesEstimate: 4 * 500 + 2 * 1500, // matches split calculation
  demandLetterSent: true,
  demandLetterDate,
  subscriberIds: ["test"],
  filedAt: null,
  filedCaseRef: null,
};

const db = JSON.parse(origCases ?? "{}");
db[key] = profile;
fs.writeFileSync(CASES_PATH, JSON.stringify(db, null, 2));

// Install a test phone.json (preserve rest of user's file if present).
const base = origPhone ? JSON.parse(origPhone) : {};
base.filingConfig = testConfig;
fs.writeFileSync(PHONE_PATH, JSON.stringify(base, null, 2));

try {
  const pkg = generateFilingPackage(key);
  if (!pkg) {
    console.error("generateFilingPackage returned null");
    process.exit(1);
  }
  fs.writeFileSync(path.join(OUT_DIR, "01-petition.txt"), pkg.petition);
  fs.writeFileSync(path.join(OUT_DIR, "02-exhibit-list.txt"), pkg.exhibitList);
  fs.writeFileSync(path.join(OUT_DIR, "03-certificate-of-service.txt"), pkg.certificateOfService);
  fs.writeFileSync(path.join(OUT_DIR, "04-filing-guide.txt"), pkg.filingGuide);
  fs.writeFileSync(path.join(OUT_DIR, "05-defendant-research.txt"), pkg.defendantResearch);
  fs.writeFileSync(path.join(OUT_DIR, "meta.json"), JSON.stringify({
    caseNumber: pkg.caseNumber,
    generatedDate: pkg.generatedDate,
    offenderNumber: pkg.offenderNumber,
    damagesRequested: pkg.damagesRequested,
    collectabilityScore: pkg.collectabilityScore,
    collectabilityBand: pkg.collectabilityBand,
    warnings: pkg.warnings,
  }, null, 2));
  console.log(`Dumped to ${OUT_DIR}`);
  console.log(`  Case number: ${pkg.caseNumber}`);
  console.log(`  Damages: $${pkg.damagesRequested}`);
  console.log(`  Warnings (${pkg.warnings.length}):`);
  for (const w of pkg.warnings) console.log(`    - ${w}`);
} finally {
  // Restore.
  if (origCases !== null) fs.writeFileSync(CASES_PATH, origCases);
  else { try { fs.unlinkSync(CASES_PATH); } catch {} }
  if (origPhone !== null) fs.writeFileSync(PHONE_PATH, origPhone);
}
