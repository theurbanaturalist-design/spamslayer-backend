import { researchTcpaDefendant, researchEntityIdentity } from "./src/services/sonarClient";

const tests = [
  { name: "Dish Network LLC", expected: "well-known TCPA defendant; should cite the 2017 $280M FTC verdict" },
  { name: "National Auto Protection", expected: "yesterday's test; should be reproducible from cache" },
  { name: "Acme Roofing Solutions", expected: "likely shell — should return little or 'not found'" },
  { name: "Zxqwer Phoenix Holdings of Atlantis", expected: "bogus name — should produce nothing useful, NOT hallucinate facts" },
];

(async () => {
  for (const t of tests) {
    console.log("\n" + "═".repeat(72));
    console.log(`DEFENDANT: ${t.name}`);
    console.log(`EXPECTATION: ${t.expected}`);
    console.log("═".repeat(72));
    const r = await researchTcpaDefendant(t.name, { noCache: true });
    if (r.status === "match") {
      console.log(`Status: MATCH  cost=$${r.costUsd.toFixed(4)}  citations=${r.citations.length}  bytes=${r.summary.length}`);
      console.log("--- Summary ---");
      console.log(r.summary);
      console.log("--- Citations (top 5) ---");
      r.citations.slice(0, 5).forEach((c, i) => console.log(`  [${i + 1}] ${c}`));
    } else if (r.status === "error") {
      console.log(`Status: ERROR — ${r.errorMessage}`);
    } else {
      console.log(`Status: SKIPPED — ${r.reason}`);
    }
  }
  console.log("\n" + "═".repeat(72));
  console.log("DONE");
})();
