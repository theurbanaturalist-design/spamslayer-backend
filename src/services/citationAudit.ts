// ─────────────────────────────────────────────────────────────────────────────
//  citationAudit.ts — Two jobs:
//
//   1. SCAN any block of text (a TypeScript source file, a generated petition,
//      a complaint draft) for citations and run each one through the verifier.
//      This is what powers the "Layer 1b" pre-existing-codebase audit and
//      what the filing gate uses to gate output.
//
//   2. PRODUCE a human-readable audit report listing every citation found,
//      where it appeared, whether it's registered, and whether it passes
//      verification.
//
//  All extraction is regex-based against well-defined citation shapes. We
//  intentionally over-extract (false positives are fine — they show up as
//  "unverifiable" and a human can dismiss them) and never under-extract
//  (a missed citation is exactly the failure mode this layer exists to
//  prevent).
// ─────────────────────────────────────────────────────────────────────────────

import fs from "fs";
import path from "path";

import {
  StructuredClaim,
  StatuteClaim,
  verifyBatch,
  BatchVerificationReport,
  VerificationResult,
} from "./citationVerifier";

// ── Citation extraction ────────────────────────────────────────────────────
//
// Each pattern produces StructuredClaims. They run greedy-but-bounded so a
// runaway regex can't eat an entire 100KB source file.

interface ExtractedCitation {
  rawCitation: string;
  kind: StatuteClaim["kind"];
  charIndex: number; // for line-number computation
}

// Federal statutes: "47 U.S.C. § 227(b)(1)(A)(iii)" or "47 USC 227(c)(5)" or
// even bare "47 USC 227". P4.4: subsection group is now optional + capped at 5
// levels of depth (matches max real-world subsection nesting in the U.S.
// Code) so a malformed petition can't smuggle in an arbitrarily-long
// pseudo-subsection train that explodes regex matching.
const FED_STATUTE_RE =
  /\b\d{1,2}\s+U\.?\s*S\.?\s*C\.?\s*(?:§|Section\b|Sec\.\b)?\s*\d+(?:\([a-zA-Z0-9]+\)){0,5}/g;

// Federal regulations: "47 C.F.R. § 64.1200(a)(1)(i)" or "16 CFR 310" or bare
// "47 CFR 64.1200". Same depth cap as FED_STATUTE_RE.
const FED_REG_RE =
  /\b\d{1,2}\s+C\.?\s*F\.?\s*R\.?\s*(?:§|Section\b|Sec\.\b)?\s*\d+(?:\.\d+)?(?:\([a-zA-Z0-9]+\)){0,5}/g;

// State statutes (a deliberately conservative pattern set — each state has
// its own citation grammar; we only match the forms our registry uses).
//
// Examples we want to catch:
//   - La. R.S. 45:844.14
//   - Cal. Bus. & Prof. Code § 17592
//   - Cal. Penal Code § 632
//   - Cal. Code Civ. Proc. § 116.110
//   - Tex. Bus. & Com. Code § 304.001
//   - Tex. Penal Code § 16.02
//   - Tex. Gov't Code § 27.031
//   - N.Y. Gen. Bus. Law § 399-z
//   - N.Y. Penal Law § 250.00
//   - N.Y. Uniform City Court Act art. 18
//   - Fla. Stat. § 501.059
//   - Ga. Code Ann. § 46-5-27
const STATE_STATUTE_RE = new RegExp(
  [
    String.raw`\bLa\.\s+R\.S\.\s+\d+:\d+(?:\.\d+)?`,
    String.raw`\bCal\.\s+(?:Bus\.\s*&\s*Prof\.|Penal|Code\s+Civ\.\s+Proc\.)\s+(?:Code\s+)?§\s*\d+(?:\.\d+)?`,
    String.raw`\bTex\.\s+(?:Bus\.\s*&\s*Com\.|Penal|Gov't)\s+Code\s+§\s*\d+(?:\.\d+)?`,
    String.raw`\bN\.Y\.\s+(?:Gen\.\s+Bus\.|Penal|Uniform\s+City\s+Court\s+Act)\s+(?:Law\s+)?(?:§|art\.)\s*[\w.-]+`,
    String.raw`\bFla\.\s+Stat\.\s+§\s*\d+(?:\.\d+)?`,
    String.raw`\bGa\.\s+Code\s+Ann\.\s+§\s*[\d-]+`,
  ].join("|"),
  "g",
);

// Federal cases — short form (named case, no reporter tail). Catches
// "Facebook v. Duguid" or "Facebook, Inc. v. Duguid" used as a quick
// reference in prose. The negative lookahead `(?!,\s*\d)` prevents this
// regex from also matching the LONG form ("Facebook, Inc. v. Duguid,
// 141 S. Ct. 1163 (2021)") — that shape is owned by FED_CASE_WITH_REPORTER_RE
// below. Without the lookahead the same citation would be extracted twice
// and inflate the audit counts.
//
// Easy to extend: add another `\bX\s*v\.\s*Y(?!,\s*\d)` alternative.
const FED_CASE_SHORTFORM_RE =
  /\bFacebook(?:,\s*Inc\.)?\s*v\.\s*Duguid(?!,\s*\d)/g;

// Federal cases — long form with reporter and year:
//   "Doe v. Roe, 123 U.S. 456 (1999)"
//   "Facebook, Inc. v. Duguid, 141 S. Ct. 1163 (2021)"
//   "ACA Int'l v. FCC, 885 F.3d 687 (D.C. Cir. 2018)" (year-only group is
//      forgiving — anything inside the parens is captured, court-name and
//      all)
//
// The pattern anchors on the reporter + year tail so it does NOT eat
// every "X v. Y" reference in prose. The reporter abbreviation set is
// the common federal ones; state-court reporters are intentionally
// excluded — our registry has no state cases and we want every "X v. Y,
// NN <state-reporter> NN" to fall through unmatched (a real citation
// that fell through the audit gate is safer than a fabricated one that
// matched our case regex but had no entry to verify against).
//
// Plaintiff/defendant names: 1-6 capitalized tokens with optional
// entity suffix (Inc/LLC/Corp/Co/L.P./N.A.). Tokens may include
// apostrophes ("Int'l") and a small handful of joiners.
const FED_CASE_WITH_REPORTER_RE = new RegExp(
  String.raw`\b[A-Z][A-Za-z.&'-]+(?:\s+(?:[A-Z][A-Za-z.&'-]+|of|the|and|&)){0,5}` +
  String.raw`(?:,\s*(?:Inc|LLC|Corp|Co|L\.?P|N\.?A)\.?)?` +
  String.raw`\s+v\.\s+` +
  String.raw`[A-Z][A-Za-z.&'-]+(?:\s+(?:[A-Z][A-Za-z.&'-]+|of|the|and|&)){0,5}` +
  String.raw`(?:,\s*(?:Inc|LLC|Corp|Co|L\.?P|N\.?A)\.?)?` +
  String.raw`,\s*\d{1,4}\s+` +
  String.raw`(?:U\.\s*S\.|S\.\s*Ct\.|F\.\s*Supp\.\s*(?:2d|3d)?|F\.\s*(?:2d|3d)?|L\.\s*Ed\.\s*(?:2d)?)` +
  String.raw`\s*\d{1,5}\s*\([^)]{1,40}\)`,
  "g",
);

// Public laws (TRACED Act etc).
const PUB_LAW_RE = /\bPub\.\s*L\.\s*\d+-\d+/g;

/**
 * Drop citations whose char range is fully contained inside another, longer
 * extracted citation at the same kind. This handles the (rare) case where
 * two regexes both fire on overlapping spans — the longer, more specific
 * match wins. Without this, e.g., a generic case regex and a name-specific
 * case regex could each push their own match for the same citation and the
 * audit would double-count.
 */
function dedupOverlapping(cits: ExtractedCitation[]): ExtractedCitation[] {
  if (cits.length < 2) return cits;
  // Sort by char index ascending, then by length descending — so that for
  // a given start, the longest hit is encountered first.
  const sorted = [...cits].sort((a, b) => {
    if (a.charIndex !== b.charIndex) return a.charIndex - b.charIndex;
    return b.rawCitation.length - a.rawCitation.length;
  });
  const out: ExtractedCitation[] = [];
  for (const c of sorted) {
    const cEnd = c.charIndex + c.rawCitation.length;
    // Drop c if any kept citation k strictly contains c.
    let contained = false;
    for (const k of out) {
      const kEnd = k.charIndex + k.rawCitation.length;
      if (k.charIndex <= c.charIndex && cEnd <= kEnd && (k.rawCitation.length > c.rawCitation.length)) {
        contained = true;
        break;
      }
    }
    if (!contained) out.push(c);
  }
  return out;
}

// Case-law signal words commonly preceding a citation in a brief or petition
// ("See X v. Y", "Cf. X v. Y"). These get greedily captured by the plaintiff-
// name portion of FED_CASE_WITH_REPORTER_RE because they start with a capital
// letter. We strip them off after the match so the extracted citation is the
// clean "Plaintiff v. Defendant, NN Reporter NN (YYYY)" form that the registry
// knows.
const CASE_SIGNAL_PREFIX_RE =
  /^(?:See\s+also|See,\s*e\.g\.,|See|Cf\.|E\.g\.,?|Accord|Under|But\s+see|Compare)\s+/;

/**
 * If the matched text starts with a case-law signal word ("See", "Cf.",
 * "Under", …), trim it off and adjust the charIndex so the audit report
 * still points to the right line.
 */
function stripCaseSignal(
  match: string,
  index: number,
): { text: string; index: number } {
  const m = CASE_SIGNAL_PREFIX_RE.exec(match);
  if (!m) return { text: match, index };
  return { text: match.slice(m[0].length), index: index + m[0].length };
}

function extractCitations(text: string): ExtractedCitation[] {
  const out: ExtractedCitation[] = [];
  for (const m of text.matchAll(FED_STATUTE_RE)) {
    out.push({ rawCitation: m[0], kind: "federal-statute", charIndex: m.index ?? 0 });
  }
  for (const m of text.matchAll(FED_REG_RE)) {
    out.push({ rawCitation: m[0], kind: "federal-regulation", charIndex: m.index ?? 0 });
  }
  for (const m of text.matchAll(STATE_STATUTE_RE)) {
    out.push({ rawCitation: m[0], kind: "state-statute", charIndex: m.index ?? 0 });
  }
  for (const m of text.matchAll(FED_CASE_SHORTFORM_RE)) {
    out.push({ rawCitation: m[0], kind: "federal-case", charIndex: m.index ?? 0 });
  }
  for (const m of text.matchAll(FED_CASE_WITH_REPORTER_RE)) {
    const { text: cleaned, index: newIdx } = stripCaseSignal(m[0], m.index ?? 0);
    out.push({ rawCitation: cleaned, kind: "federal-case", charIndex: newIdx });
  }
  for (const m of text.matchAll(PUB_LAW_RE)) {
    out.push({ rawCitation: m[0], kind: "federal-public-law", charIndex: m.index ?? 0 });
  }
  return dedupOverlapping(out);
}

// Compute the 1-indexed line number for a character index in a text blob.
function lineForCharIndex(text: string, charIndex: number): number {
  let line = 1;
  for (let i = 0; i < charIndex && i < text.length; i++) {
    if (text.charCodeAt(i) === 10) line++; // \n
  }
  return line;
}

// Pull a small slice of context around a citation for the consistency check.
//
// IMPORTANT: keep this window narrow. A wide window (e.g. 200 chars) will
// frequently span multiple citation blocks in source code — for example a
// cellular-line citation followed three lines later by a residential-line
// citation gets one big context blob and falsely conflicts on "residential."
// We bound to the same line + the next line, capturing multi-line callouts
// (which are common in this codebase) without crossing into adjacent claims.
function contextAround(text: string, charIndex: number, citationLen: number): string {
  // Find start of current line.
  let start = charIndex;
  while (start > 0 && text.charCodeAt(start - 1) !== 10) start--;
  // Find end of next line (i.e. allow one line of trailing context).
  let end = charIndex + citationLen;
  let newlinesSeen = 0;
  while (end < text.length && newlinesSeen < 2) {
    if (text.charCodeAt(end) === 10) newlinesSeen++;
    end++;
  }
  return text.slice(start, end);
}

// ── Public scanning API ─────────────────────────────────────────────────────

export interface AuditedCitation {
  citation: string;
  kind: StatuteClaim["kind"];
  file: string;
  line: number;
  result: VerificationResult;
}

export interface AuditReport {
  scannedFiles: string[];
  totalCitationsFound: number;
  byStatus: { verified: number; unverified: number; conflict: number };
  citations: AuditedCitation[];
  /** Pre-formatted summary for printing or shipping in a warning. */
  humanReadable: string;
}

/**
 * Scan a block of text for citations and verify each one.
 * The text can be a TypeScript source file, a generated petition, or any
 * other prose. file/lineOffset are used only for reporting purposes.
 */
export function scanText(text: string, file: string): AuditedCitation[] {
  const extracted = extractCitations(text);
  const claims: StructuredClaim[] = extracted.map((e) => {
    const ctx = contextAround(text, e.charIndex, e.rawCitation.length);
    const claim: StatuteClaim = {
      kind: e.kind,
      rawCitation: e.rawCitation,
      context: ctx,
      location: { file, line: lineForCharIndex(text, e.charIndex) },
    };
    return claim;
  });
  const report = verifyBatch(claims);
  return extracted.map((e, i) => ({
    citation: e.rawCitation,
    kind: e.kind,
    file,
    line: lineForCharIndex(text, e.charIndex),
    result: report.results[i],
  }));
}

/**
 * Scan every .ts/.tsx file under the given directory (recursive). Returns a
 * unified audit report.
 */
export function auditDirectory(rootDir: string): AuditReport {
  return auditDirectories([rootDir]);
}

/**
 * Scan every .ts/.tsx file under each of the given directories (recursive).
 * Results are merged into a single report.
 *
 * Use this when citations are known to live in multiple trees (e.g. the
 * backend services directory AND the frontend lib directory where
 * stateLaws.ts holds the state-by-state DNC / recording / small-claims
 * citations surfaced in the Settings dropdown).
 */
export function auditDirectories(rootDirs: string[]): AuditReport {
  const seen = new Set<string>();
  const files: string[] = [];
  for (const root of rootDirs) {
    for (const f of walkTypeScriptFiles(root)) {
      if (seen.has(f)) continue;
      seen.add(f);
      files.push(f);
    }
  }
  const all: AuditedCitation[] = [];
  for (const f of files) {
    const text = fs.readFileSync(f, "utf-8");
    all.push(...scanText(text, f));
  }
  return buildReport(all, files);
}

/**
 * Scan an arbitrary set of {file, text} pairs. Useful for auditing freshly-
 * generated petition/exhibit/guide strings before they're saved.
 */
export function auditTextBlobs(blobs: Array<{ file: string; text: string }>): AuditReport {
  const all: AuditedCitation[] = [];
  const files = blobs.map((b) => b.file);
  for (const b of blobs) {
    all.push(...scanText(b.text, b.file));
  }
  return buildReport(all, files);
}

/**
 * Convenience: audit every citation in a single block of text. Returns true
 * iff every found citation is verified. Used by the filing gate.
 */
export function quickGate(
  text: string,
  file: string,
): { passed: boolean; report: AuditReport } {
  const cits = scanText(text, file);
  const report = buildReport(cits, [file]);
  return { passed: report.byStatus.unverified === 0 && report.byStatus.conflict === 0, report };
}

// ── Internal helpers ────────────────────────────────────────────────────────

// Files excluded from the scan — these contain example citations in
// comments/strings that are part of the verifier machinery itself, not
// user-facing legal output. Keeping them in would drown real findings in
// self-referential noise.
const SCAN_EXCLUDE = new Set([
  "statuteRegistry.ts",
  "citationVerifier.ts",
  "citationAudit.ts",
]);

function walkTypeScriptFiles(rootDir: string): string[] {
  const out: string[] = [];
  const stack: string[] = [rootDir];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (ent.name === "node_modules" || ent.name === "dist" || ent.name.startsWith(".")) continue;
        stack.push(full);
      } else if (
        ent.isFile() &&
        (ent.name.endsWith(".ts") || ent.name.endsWith(".tsx"))
      ) {
        // Also skip .d.ts type-declaration noise — they don't carry
        // user-facing citations.
        if (ent.name.endsWith(".d.ts")) continue;
        if (SCAN_EXCLUDE.has(ent.name)) continue;
        out.push(full);
      }
    }
  }
  return out;
}

function buildReport(
  all: AuditedCitation[],
  scannedFiles: string[],
): AuditReport {
  let verified = 0,
    unverified = 0,
    conflict = 0;
  for (const a of all) {
    if (a.result.status === "verified") verified++;
    else if (a.result.status === "conflict") conflict++;
    else unverified++;
  }
  return {
    scannedFiles,
    totalCitationsFound: all.length,
    byStatus: { verified, unverified, conflict },
    citations: all,
    humanReadable: formatReport(all, scannedFiles, { verified, unverified, conflict }),
  };
}

function formatReport(
  cits: AuditedCitation[],
  files: string[],
  totals: { verified: number; unverified: number; conflict: number },
): string {
  const lines: string[] = [];
  lines.push("CITATION AUDIT REPORT");
  lines.push("─".repeat(60));
  lines.push(`Scanned files: ${files.length}`);
  lines.push(`Citations found: ${cits.length}`);
  lines.push(
    `Verified: ${totals.verified}   ` +
    `Unverified: ${totals.unverified}   ` +
    `Conflicts: ${totals.conflict}`,
  );
  lines.push("");
  if (totals.conflict > 0) {
    lines.push("CONFLICTS (citation matched the registry but context contradicts it):");
    for (const c of cits) {
      if (c.result.status !== "conflict") continue;
      lines.push(`  ${c.file}:${c.line}  "${c.citation}"`);
      lines.push(`    → ${c.result.detail}`);
    }
    lines.push("");
  }
  if (totals.unverified > 0) {
    // Group by reason for readability.
    const byReason: Record<string, AuditedCitation[]> = {};
    for (const c of cits) {
      if (c.result.status !== "unverified") continue;
      const r = c.result.reason;
      (byReason[r] ??= []).push(c);
    }
    lines.push("UNVERIFIED:");
    for (const [reason, items] of Object.entries(byReason)) {
      lines.push(`  [${reason}] (${items.length})`);
      for (const c of items.slice(0, 25)) {
        lines.push(`    ${c.file}:${c.line}  "${c.citation}"`);
      }
      if (items.length > 25) lines.push(`    … and ${items.length - 25} more`);
    }
    lines.push("");
  }
  if (totals.verified > 0) {
    lines.push("VERIFIED (sampled):");
    let shown = 0;
    for (const c of cits) {
      if (c.result.status !== "verified" || shown >= 10) continue;
      lines.push(`  ${c.file}:${c.line}  "${c.citation}"`);
      shown++;
    }
    if (totals.verified > 10) lines.push(`  … and ${totals.verified - 10} more verified`);
  }
  return lines.join("\n");
}

// ── CLI entrypoint ─────────────────────────────────────────────────────────
// Run: `npx ts-node -T src/services/citationAudit.ts <dir>` (or just default
// to the services directory). Prints the report to stdout and exits non-zero
// if any conflicts were found.

if (require.main === module) {
  // CLI: pass any number of root paths, or rely on the defaults.
  // Defaults cover the two known citation-bearing trees:
  //   - backend/src/services (this directory)
  //   - frontend/src/lib     (stateLaws.ts and siblings)
  // If you add a new directory that holds citations, add it here so the
  // unattended audit picks it up.
  let roots: string[];
  if (process.argv.length > 2) {
    roots = process.argv.slice(2);
  } else {
    const here = path.resolve(__dirname);                                 // …/backend/src/services
    const repoRoot = path.resolve(here, "..", "..", "..");                // …/spamslayer
    const frontendLib = path.resolve(repoRoot, "frontend", "src", "lib");
    roots = [here];
    // Only include frontend/src/lib if it actually exists — keeps the
    // audit usable on a backend-only checkout.
    try {
      if (fs.statSync(frontendLib).isDirectory()) roots.push(frontendLib);
    } catch {
      /* frontend not present — backend-only run */
    }
  }
  const report = auditDirectories(roots);
  // eslint-disable-next-line no-console
  console.log(`Audit roots:\n${roots.map((r) => "  " + r).join("\n")}\n`);
  // eslint-disable-next-line no-console
  console.log(report.humanReadable);
  if (report.byStatus.conflict > 0) {
    process.exitCode = 2;
  } else if (report.byStatus.unverified > 0) {
    process.exitCode = 1;
  }
}

// ── A useful reverse lookup: which registered citations are NOT used? ──────
//
// (Helpful for cleaning up the registry, but not part of the verifier
// gate itself.)
export function unusedRegistryEntries(usedCitations: string[]): string[] {
  const used = new Set(usedCitations.map((c) => c.toLowerCase().trim()));
  // Lazy-import to avoid circular dependencies in test setups.
  const reg = require("./statuteRegistry") as typeof import("./statuteRegistry");
  return reg
    .listAllEntries()
    .filter((e) => {
      if (used.has(e.canonical.toLowerCase())) return false;
      for (const a of e.aliases) {
        if (used.has(a.toLowerCase())) return false;
      }
      return true;
    })
    .map((e) => e.canonical);
}
