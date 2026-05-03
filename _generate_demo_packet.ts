// Standalone script — generates a complete demo filing packet for the
// fictional auto-warranty offender and writes it to a known output dir.
// Used to produce shareable artifacts for demos (not a runtime path).
//
// Usage: npx tsx _generate_demo_packet.ts

import * as DemoSeed from "./src/services/demoSeed";
import { generateAndSaveFilingPackage } from "./src/services/legalFilingGenerator";

const OUT_DIR = process.argv[2] || "./filings";

console.log("[DemoPacket] Seeding demo offender...");
const { created, offender } = DemoSeed.seedDemoCase();
console.log(
  `[DemoPacket] ${created ? "Created" : "Refreshed"} ${offender.normalizedNumber} ` +
  `(${offender.callCount} calls, $${offender.damagesEstimate} damages)`
);

console.log("[DemoPacket] Generating filing packet...");
const result = generateAndSaveFilingPackage(
  DemoSeed.DEMO_PHONE,
  OUT_DIR,
  DemoSeed.DEMO_FILING_OVERRIDES
);

if (!result) {
  console.error("[DemoPacket] FAILED — generator returned null.");
  process.exit(1);
}

console.log(`[DemoPacket] Saved to: ${result.dir}`);
console.log("[DemoPacket] Files:");
for (const f of result.files) console.log("  -", f);
