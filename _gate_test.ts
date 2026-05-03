import { generateAndSaveFilingPackage, FilingDecisionError } from "./src/services/legalFilingGenerator";
const cfg = {
  userName: "Marcus Test", userAddress: "100 Test St", userCity: "Lafayette",
  userState: "LA", userZip: "70501", userPhone: "+13375550100",
  userEmail: "test@example.invalid",
  courtName: "Lafayette City Court", courtAddress: "105 East Convent St",
  courtCity: "Lafayette", courtState: "LA", courtZip: "70501",
  courtClerkPhone: "(337) 291-8702", parishOrCounty: "Lafayette Parish",
  dncRegistrationDate: "2020-06-15",
  filingFee: "$75.00", serviceFee: "$25.00",
  lineType: "residential" as const,
};
console.log("=== Try without override (expect refusal if DONT_FILE) ===");
try {
  const r = generateAndSaveFilingPackage("+15555550188", undefined, cfg);
  if (r) console.log("Saved. Files:", r.files.length);
} catch (e: any) {
  if (e.name === "FilingDecisionError") {
    console.log("✓ Refused as expected: " + e.decision.verdict + " (" + e.decision.confidence + "%)");
    console.log("  Net EV: $" + (e.decision.expectedValueUsd - e.decision.costEstimateUsd));
  } else if (e.name === "CitationGateError") {
    console.log("(Citation gate caught it before decision gate — fine)");
  } else throw e;
}
console.log();
console.log("=== Try WITH override (should save even if DONT_FILE) ===");
try {
  const r = generateAndSaveFilingPackage("+15555550188", undefined, cfg, { overrideDecision: true });
  if (r) console.log("✓ Saved with override:", r.files.length, "files");
} catch (e: any) {
  if (e.name === "CitationGateError") console.log("(citation gate caught — also fine)");
  else throw e;
}
