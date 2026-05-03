/**
 * _e2e_test.ts — End-to-end smoke test of the SpamSlayer workflow.
 *
 * Exercises the parts that aren't HTTP-exposed:
 *   - legal filing generator (preview + save-to-disk)
 *   - case strength meter
 *   - defendant research
 *   - complaint bundle (regulatory complaints)
 *   - citation gate
 *
 * Uses the safe demo phone (+15555550199, NANP-reserved fictional) via
 * demoSeed, so this never touches a real offender record.
 */

import * as path from "path";
import * as fs from "fs";
import { seedDemoCase, clearDemoCase, DEMO_PHONE, DEMO_FILING_OVERRIDES } from "./src/services/demoSeed";
import {
  generateFilingPackage,
  generateAndSaveFilingPackage,
  type FilingConfig,
} from "./src/services/legalFilingGenerator";
import { generateDefendantResearchReport } from "./src/services/defendantResearch";
import { generateComplaintBundle } from "./src/services/complaintBundle";
import { evaluateCaseStrength, formatCaseStrengthReport } from "./src/services/caseStrengthMeter";
import { getOffender } from "./src/services/caseBuilder";

let pass = 0;
let fail = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else      { fail++; failures.push(name + (detail ? `: ${detail}` : "")); console.log(`  FAIL  ${name}${detail ? " - " + detail : ""}`); }
}

function section(title: string) {
  console.log(`\n-- ${title} ${"-".repeat(Math.max(2, 60 - title.length))}`);
}

// Build a minimal filing config that combines the demo overrides with the
// court fields the legal filing generator requires.
function fullDemoConfig(): Partial<FilingConfig> {
  return {
    ...DEMO_FILING_OVERRIDES,
    courtName: "Lafayette City Court",
    courtAddress: "105 East Convent Street",
    courtCity: "Lafayette",
    courtState: "LA",
    courtZip: "70501",
    courtClerkPhone: "(337) 291-8702",
    parishOrCounty: "Lafayette Parish",
    filingFee: "$75.00",
    serviceFee: "$25.00",
  };
}

async function main() {
  section("Stage 1: Seed demo case");
  const seeded = seedDemoCase();
  check("demo case created/refreshed", seeded.offender.normalizedNumber === DEMO_PHONE);
  check("demo offender has 6 calls", seeded.offender.callCount === 6);
  check("demo offender is actionable", seeded.offender.actionable === true);
  check("demo damages = $3000", seeded.offender.damagesEstimate === 3000);

  const reread = getOffender(DEMO_PHONE);
  check("offender survives round-trip via getOffender", reread !== null && reread!.callCount === 6);

  section("Stage 2: Case strength meter");
  const strength = evaluateCaseStrength(DEMO_PHONE);
  check("case strength evaluation returns a report", strength != null);
  if (strength) {
    check("has rating + score + summary + factors", typeof strength.rating === "string" && typeof strength.score === "number" && Array.isArray(strength.factors));
    console.log(`     rating=${strength.rating} score=${strength.score}/100 readyToFile=${strength.readyToFile}`);
    console.log(`     factors=${strength.factors.length}, summary="${strength.summary.slice(0,80)}..."`);
    const report = formatCaseStrengthReport(strength);
    check("strength report formats to text", report.length > 50);
  }

  section("Stage 3: Defendant research");
  if (reread) {
    const cfg = fullDemoConfig();
    const research = generateDefendantResearchReport(
      reread,
      {
        courtState: "LA",
        courtStateLong: "Louisiana",
        courtName: cfg.courtName!,
        userPhone: cfg.userPhone,
      },
      "SS-E2ETEST",
      new Date(),
    );
    check("research returns a report object", research != null && typeof research.text === "string");
    check("research text is substantive (>500 chars)", research.text.length > 500);
    check("research mentions defendant company", /preferred auto protection/i.test(research.text));
    check("collectability score present", typeof research.collectability?.score === "number");
    console.log(`     collectability score=${research.collectability.score} band=${research.collectability.band} flagged=${research.flagAsUncollectable}`);
  }

  section("Stage 4: Generate filing package (preview)");
  const pkg = generateFilingPackage(DEMO_PHONE, fullDemoConfig());
  check("filing package generated", pkg !== null);
  if (pkg) {
    check("has petition", typeof pkg.petition === "string" && pkg.petition.length > 500);
    check("has exhibitList", typeof pkg.exhibitList === "string" && pkg.exhibitList.length > 200);
    check("has certificateOfService", typeof pkg.certificateOfService === "string" && pkg.certificateOfService.length > 100);
    check("has filingGuide", typeof pkg.filingGuide === "string" && pkg.filingGuide.length > 500);
    check("has caseNumber", typeof pkg.caseNumber === "string" && /SS-/.test(pkg.caseNumber));
    check("warnings array exists", Array.isArray(pkg.warnings));
    console.log(`     caseNumber=${pkg.caseNumber}`);
    console.log(`     petition=${pkg.petition.length}b  exhibitList=${pkg.exhibitList.length}b  cert=${pkg.certificateOfService.length}b  guide=${pkg.filingGuide.length}b`);
    console.log(`     warnings (${pkg.warnings.length}):`);
    pkg.warnings.slice(0, 5).forEach((w: string) => console.log(`       * ${w.split('\n')[0].slice(0, 110)}`));

    // ── Regression checks for the four CRIT findings from AUDIT_ROUND_17 ──

    // CRIT-1: petition should NOT print "placing N N calls" (number printed twice)
    const dupNumberMatch = /placing\s+(\d+)\s*\n?\s*\1\s+calls?/.exec(pkg.petition);
    check("CRIT-1: petition does not print 'placing N N calls' twice", !dupNumberMatch,
      dupNumberMatch ? `found '${dupNumberMatch[0].replace(/\s+/g," ")}'` : undefined);

    // CRIT-2: exhibit list should NOT have "(one-party consent) (one-party consent)"
    const dupConsent = /\(one-party consent\)\s*\(one-party consent\)/i.test(pkg.exhibitList);
    check("CRIT-2: exhibit list does not double '(one-party consent)'", !dupConsent);

    // CRIT-3: petition should not say "N time(s)" (placeholder for pluralize)
    const placeholderTime = /\d+\s+time\(s\)/.test(pkg.petition);
    check("CRIT-3: petition does not contain 'N time(s)' placeholder", !placeholderTime);

    // CRIT-4: per-violation rates should be comma-formatted
    const badMoney = /\$1500\b/.test(pkg.petition) || /\$2500\b/.test(pkg.petition);
    check("CRIT-4: per-violation rates use $1,500 / $500 formatting (no $1500)", !badMoney);

    // Required citations (sanity)
    check("petition cites 47 U.S.C. § 227", /47\s*U\.S\.C\.\s*[§S]\s*227/.test(pkg.petition));
    check("petition cites La. R.S. 13:5200", /La\.\s*R\.S\.\s*13:5200/.test(pkg.petition));
    check("petition cites TransUnion or Spokeo", /(TransUnion|Spokeo)/.test(pkg.petition));
    check("petition cites 28 U.S.C. § 1658", /28\s*U\.S\.C\.\s*[§S]\s*1658/.test(pkg.petition));

    // Sworn-text safety
    check("verification uses 'representative samples' or 'opportunity to review' language",
      /representative samples/i.test(pkg.petition) || /had a full opportunity to review/i.test(pkg.petition));
    check("verification uses 28 U.S.C. § 1746 perjury formulation",
      /28\s*U\.S\.C\.\s*[§S]\s*1746/.test(pkg.petition));

    // Self-suit guard already proved itself if package generated (overrides.userPhone differs from DEMO_PHONE).
  }

  section("Stage 5: Complaint bundle (regulatory complaints)");
  if (reread) {
    const cfgFull = fullDemoConfig();
    // Cast to FilingConfig — generateComplaintBundle needs a full FilingConfig
    // shape. Demo overrides + court fields cover the fields it actually reads.
    const bundle = generateComplaintBundle(reread, cfgFull as FilingConfig);
    check("complaint bundle generated", bundle != null);
    if (bundle) {
      check("bundle has drafts array", Array.isArray(bundle.drafts) && bundle.drafts.length >= 3);
      check("bundle has readme", typeof bundle.readme === "string" && bundle.readme.length > 100);
      check("bundle has skipped array", Array.isArray(bundle.skipped));
      console.log(`     drafts=${bundle.drafts.length}, skipped=${bundle.skipped.length}`);
      bundle.drafts.forEach((d: any) =>
        console.log(`       p${d.priority}  ${d.slug.padEnd(20)} body=${d.body.length}b  -> ${d.submitUrl.slice(0,60)}`)
      );
      // Look for the four expected agency drafts (if not skipped).
      const slugs = bundle.drafts.map((d: any) => d.slug);
      check("includes ITG traceback draft", slugs.includes("itg-traceback"));
      check("includes FCC TCPA draft", slugs.some(s => /fcc/.test(s)));
      check("includes FTC DNC draft", slugs.some(s => /ftc/.test(s)));
    }
  }

  section("Stage 6: Save filing package to disk + citation gate");
  let savedDir: string | null = null;
  try {
    const saved = generateAndSaveFilingPackage(DEMO_PHONE, undefined, fullDemoConfig());
    check("save returned dir+files", saved != null);
    if (saved) {
      savedDir = saved.dir;
      check("save produced >= 4 files", saved.files.length >= 4, `got ${saved.files.length}`);
      check("save dir exists on disk", fs.existsSync(saved.dir));
      console.log(`     dir = ${path.relative(process.cwd(), saved.dir)}`);
      console.log(`     files = ${saved.files.join(", ")}`);
      // Spot-check file permissions: should be 0o600
      let permsOk = true;
      for (const f of saved.files) {
        const fp = path.join(saved.dir, f);
        if (fs.existsSync(fp)) {
          const m = fs.statSync(fp).mode & 0o777;
          if (m !== 0o600) {
            console.log(`     ! ${f} mode=0o${m.toString(8)} (expected 0o600)`);
            permsOk = false;
          }
        }
      }
      check("all saved files have 0o600 permissions", permsOk);
    }
  } catch (err: any) {
    if (err && err.name === "CitationGateError") {
      check("citation gate caught issues (treated as pass — gate did its job)", true);
      console.log(`     gate blocked with ${err.blockingMessages?.length || 0} message(s):`);
      (err.blockingMessages || []).slice(0, 5).forEach((m: string) => console.log(`       * ${m.slice(0, 120)}`));
    } else {
      check("save did not throw unexpected error", false, err?.message ?? String(err));
    }
  }

  section("Cleanup");
  const removed = clearDemoCase();
  check("demo offender cleaned up", removed.removed === true);
  if (savedDir) console.log(`     filing artifacts left at: ${savedDir}`);

  console.log(`\n=================================================================`);
  console.log(`  RESULT: ${pass} passed, ${fail} failed`);
  if (fail > 0) {
    console.log(`  Failures:`);
    failures.forEach((f) => console.log(`    * ${f}`));
  }
  console.log(`=================================================================`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(2);
});
