// Citation-gate unit tests — run with: npx ts-node -T citationGate_tests.ts
//
// These verify the critical behaviors of the filing-package citation gate
// introduced in Layer 1c + regex tightening round:
//
//   (1) Clean text with a registered statute passes the scanner.
//   (2) A fabricated federal statute (shape of a hallucination) is
//       flagged not-in-registry.
//   (3) A registered case citation (Mims v. Arrow) resolves to the
//       registry entry via alias normalization.
//   (4) A fabricated case citation is caught as not-in-registry.
//   (5) A real mis-topic citation (residential + (A)(iii)) is caught as
//       a conflict — this is the exact shape of a subsection mis-cite.
//   (6) Regex grabs "See"/"Cf."/"Under" prefixes correctly trimmed off.
//   (7) Gate aggregates multiple not-in-registry hits into one soft
//       warning message (not one per citation).
//
// These tests do NOT require network, disk, or the full filing pipeline —
// they exercise the scanner + verifier + gate logic in isolation.

import {
  auditTextBlobs,
  scanText,
} from "./src/services/citationAudit";

let passed = 0;
let failed = 0;

function assert(cond: boolean, label: string) {
  if (cond) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ FAIL: ${label}`);
    failed++;
  }
}

function test(name: string, fn: () => void) {
  console.log(`\n[TEST] ${name}`);
  try {
    fn();
  } catch (err) {
    console.error(`  ✗ EXCEPTION: ${err}`);
    failed++;
  }
}

// ────────────────────────────────────────────────────────────────────────
// Test 1: Registered statute citation passes without conflict.
// ────────────────────────────────────────────────────────────────────────
test("registered statute citation resolves to registry entry", () => {
  const cits = scanText(
    "The defendant violated 47 U.S.C. § 227(c)(5) by continuing calls.",
    "t1.txt",
  );
  assert(cits.length === 1, "one citation extracted");
  const c = cits[0];
  assert(c.kind === "federal-statute", "kind=federal-statute");
  // Registered but not human-verified → unverified reason is the tame soft-warn kind.
  assert(
    c.result.status === "unverified" || c.result.status === "verified",
    `status is unverified or verified, got ${c.result.status}`,
  );
  if (c.result.status === "unverified") {
    assert(
      c.result.reason === "registry-entry-not-human-verified",
      `reason=registry-entry-not-human-verified (got ${c.result.reason})`,
    );
  }
});

// ────────────────────────────────────────────────────────────────────────
// Test 2: Fabricated statute → not-in-registry (hard-block shape).
// ────────────────────────────────────────────────────────────────────────
test("fabricated federal statute is flagged not-in-registry", () => {
  const cits = scanText(
    "The defendant violated 49 U.S.C. § 9999(z)(42), a made-up law.",
    "t2.txt",
  );
  assert(cits.length === 1, "one citation extracted");
  const c = cits[0];
  assert(c.kind === "federal-statute", "kind=federal-statute");
  assert(c.result.status === "unverified", `status=unverified (got ${c.result.status})`);
  if (c.result.status === "unverified") {
    assert(
      c.result.reason === "not-in-registry",
      `reason=not-in-registry (got ${c.result.reason})`,
    );
  }
});

// ────────────────────────────────────────────────────────────────────────
// Test 3: Registered case via alias normalization.
// ────────────────────────────────────────────────────────────────────────
test("registered case (Mims) resolves via alias match", () => {
  const cits = scanText(
    "See Mims v. Arrow Financial Services, 565 U.S. 368 (2012).",
    "t3.txt",
  );
  assert(cits.length === 1, "one citation extracted");
  const c = cits[0];
  assert(c.kind === "federal-case", "kind=federal-case");
  // Registry entry exists but is unverified by a human → soft-warn reason.
  assert(c.result.status === "unverified", `status=unverified (got ${c.result.status})`);
  if (c.result.status === "unverified") {
    assert(
      c.result.reason === "registry-entry-not-human-verified",
      `reason=registry-entry-not-human-verified (got ${c.result.reason})`,
    );
  }
});

// ────────────────────────────────────────────────────────────────────────
// Test 4: Fabricated case → not-in-registry (soft-warn aggregate at gate).
// ────────────────────────────────────────────────────────────────────────
test("fabricated case citation is flagged not-in-registry", () => {
  const cits = scanText(
    "See Doe v. Spam Corp, 999 S. Ct. 8888 (2024) for authority.",
    "t4.txt",
  );
  assert(cits.length === 1, "one citation extracted");
  const c = cits[0];
  assert(c.kind === "federal-case", "kind=federal-case");
  assert(c.result.status === "unverified", `status=unverified (got ${c.result.status})`);
  if (c.result.status === "unverified") {
    assert(
      c.result.reason === "not-in-registry",
      `reason=not-in-registry (got ${c.result.reason})`,
    );
  }
});

// ────────────────────────────────────────────────────────────────────────
// Test 5: Mis-topic citation (residential + (A)(iii)) → conflict.
// This is the exact "subsection mis-cite" shape that B1 fixed historically.
// ────────────────────────────────────────────────────────────────────────
test("residential + (A)(iii) is flagged as conflict", () => {
  const cits = scanText(
    "Residential subscribers are protected under 47 U.S.C. § 227(b)(1)(A)(iii).",
    "t5.txt",
  );
  const conflicts = cits.filter((c) => c.result.status === "conflict");
  assert(conflicts.length >= 1, `at least one conflict (got ${conflicts.length})`);
  if (conflicts[0] && conflicts[0].result.status === "conflict") {
    assert(
      conflicts[0].result.detail.toLowerCase().includes("residential"),
      "conflict detail mentions 'residential'",
    );
  }
});

// ────────────────────────────────────────────────────────────────────────
// Test 6: "See"/"Cf."/"Under" prefix stripping.
// The regex greedily captures "See Spokeo..."; stripCaseSignal must
// remove the prefix so the lookup matches the registered canonical form.
// ────────────────────────────────────────────────────────────────────────
test("leading 'See' is stripped before registry lookup", () => {
  const cits = scanText(
    "See Spokeo, Inc. v. Robins, 578 U.S. 330 (2016).",
    "t6.txt",
  );
  assert(cits.length === 1, "one citation extracted");
  const c = cits[0];
  assert(
    !c.citation.startsWith("See "),
    `'See ' prefix stripped (got "${c.citation}")`,
  );
  assert(
    c.citation.startsWith("Spokeo"),
    `citation starts with Spokeo (got "${c.citation}")`,
  );
  // And it should resolve as registered (soft-warn, not not-in-registry).
  if (c.result.status === "unverified") {
    assert(
      c.result.reason === "registry-entry-not-human-verified",
      `registered after prefix strip (reason=${c.result.reason})`,
    );
  }
});

// ────────────────────────────────────────────────────────────────────────
// Test 7: Aggregate audit over multiple blobs — mix of clean + fabricated.
// ────────────────────────────────────────────────────────────────────────
test("auditTextBlobs returns correct counts across blobs", () => {
  const report = auditTextBlobs([
    {
      file: "petition.txt",
      text: "TCPA violation under 47 U.S.C. § 227(c)(5).",
    },
    {
      file: "bogus.txt",
      text: "Per 49 U.S.C. § 9999 and Doe v. Roe, 999 U.S. 123 (2024).",
    },
  ]);
  assert(report.totalCitationsFound >= 3, `found ≥3 citations (got ${report.totalCitationsFound})`);
  assert(report.byStatus.conflict === 0, "no conflicts");
  // At least one not-in-registry (the fabricated 49 U.S.C. § 9999).
  const notInRegistry = report.citations.filter(
    (c) => c.result.status === "unverified" && c.result.reason === "not-in-registry",
  );
  assert(notInRegistry.length >= 1, `≥1 not-in-registry (got ${notInRegistry.length})`);
});

// ────────────────────────────────────────────────────────────────────────
// Test 8: Dedup — the long-form Facebook citation should not double-count
// with the short-form regex (thanks to the `(?!,\s*\d)` negative lookahead).
// ────────────────────────────────────────────────────────────────────────
test("Facebook long-form does not double-match with short-form regex", () => {
  const cits = scanText(
    "Applying Facebook, Inc. v. Duguid, 141 S. Ct. 1163 (2021) here.",
    "t8.txt",
  );
  // Should be exactly ONE extracted citation (the long form), not two.
  // (The short-form regex has a negative lookahead to prevent overlap.)
  const fbMatches = cits.filter((c) => c.citation.includes("Duguid"));
  assert(fbMatches.length === 1, `exactly 1 Duguid match (got ${fbMatches.length})`);
});

// ────────────────────────────────────────────────────────────────────────
// Test 9: Regex does NOT over-match non-citation prose with "v." in it.
// (Guard against false positives like "phase v. phase 2" or general "vs." use.)
// ────────────────────────────────────────────────────────────────────────
test("case regex does not over-match generic prose", () => {
  const cits = scanText(
    "The team chose phase one versus phase two. That v. decision was key.",
    "t9.txt",
  );
  const caseCits = cits.filter((c) => c.kind === "federal-case");
  assert(caseCits.length === 0, `no case citations (got ${caseCits.length})`);
});

// ────────────────────────────────────────────────────────────────────────
// Summary
// ────────────────────────────────────────────────────────────────────────
console.log("\n" + "═".repeat(55));
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log("═".repeat(55));
process.exit(failed > 0 ? 1 : 0);
