import { generateAndSaveFilingPackage } from "./src/services/legalFilingGenerator";
import { getOffender } from "./src/services/caseBuilder";
const o = getOffender("+15555550188");
console.log("offender has Sonar?", o?.defendantWebResearch?.status);
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
try {
  const r = generateAndSaveFilingPackage("+15555550188", undefined, cfg);
  if (r) console.log("saved to", r.dir);
} catch (e: any) {
  if (e.name === "CitationGateError") console.log("gate blocked:", (e.blockingMessages||[]).slice(0,2));
  else throw e;
}
