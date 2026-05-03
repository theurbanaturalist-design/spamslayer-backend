import { generateAndSaveFilingPackage } from "./src/services/legalFilingGenerator";
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
  const r = generateAndSaveFilingPackage("+15555550101", undefined, cfg, { overrideDecision: true });
  if (r) {
    console.log("Saved files:");
    r.files.forEach(f => console.log("  " + f.split('/').slice(-2).join('/')));
  }
} catch (e: any) {
  if (e.name === "CitationGateError") console.log("(citation gate caught)");
  else throw e;
}
