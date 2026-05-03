// ─────────────────────────────────────────────────────────────────────────────
//  citationVerifier.ts — The gate between "any legal citation that appears in
//  our output" and "the user sees it."
//
//  THE INVARIANT THIS MODULE EXISTS TO ENFORCE:
//     No citation reaches the user unless it is present in the
//     citation registry (statuteRegistry.ts).
//
//  Why: we build sworn legal filings. A fabricated, typo'd, or hallucinated
//  citation in a sworn filing is a real sanction risk. The registry is the
//  human-curated allowlist of citations this product claims to know about.
//  Anything else is treated as untrusted — the verifier returns "unverified"
//  and the filing gate refuses to include it (or includes it only with an
//  explicit, user-acknowledged "UNVERIFIED" warning).
//
//  The verifier does three jobs:
//    1. PARSE a raw citation string into a canonical form.
//    2. LOOK UP the canonical form in the registry.
//    3. CROSS-CHECK the surrounding context: if the codebase says
//       "§ 227(b)(1)(A)(iii) — residential," the misTopicKeywords check
//       catches that mismatch (because (A)(iii) is about cellular, not
//       residential).
//
//  This module is intentionally LLM-free. It's a pure function over
//  structured inputs. If an LLM is ever wired into SpamSlayer, its output
//  must still pass through this verifier before reaching the user.
// ─────────────────────────────────────────────────────────────────────────────

import {
  findRegistryEntry,
  CitationEntry,
} from "./statuteRegistry";

// ── Structured claim types ──────────────────────────────────────────────────
//
// StructuredClaim is the only input shape the verifier accepts from upstream
// code. Free prose is not verifiable — if a caller has free prose, they must
// first extract structured claims (e.g. via regex in citationAudit.ts).

export interface StatuteClaim {
  kind: "federal-statute" | "federal-regulation" | "federal-public-law" | "federal-case" | "state-statute" | "state-rule";
  /** Raw citation as it appears in source text. Will be normalized. */
  rawCitation: string;
  /**
   * Optional sentence of surrounding context from the source document.
   * The verifier uses this to check for topic/misTopic keyword mismatches.
   * Keep it short (< 500 chars) — longer contexts generate noisier matches.
   */
  context?: string;
  /** File + line where the citation appears, for audit reporting. */
  location?: {
    file: string;
    line?: number;
  };
}

export interface QuoteClaim {
  kind: "quote";
  /**
   * A claimed verbatim quote from a statute/case. Verifiable only if the
   * cited entry has a verifiedQuote filled in by a human. Absent that, the
   * verifier conservatively returns "unverifiable" — it does NOT attempt to
   * judge whether the quote sounds correct.
   */
  rawCitation: string;
  quote: string;
  location?: { file: string; line?: number };
}

export type StructuredClaim = StatuteClaim | QuoteClaim;

// ── Verification result types ──────────────────────────────────────────────

export type VerificationResult =
  | VerificationVerified
  | VerificationUnverified
  | VerificationConflict;

export interface VerificationVerified {
  status: "verified";
  claim: StructuredClaim;
  matchedEntry: CitationEntry;
  /** How we matched: canonical form, alias, or normalized form. */
  matchedVia: "canonical" | "alias";
  /**
   * Consistency-check outcomes. Even if the entry is human-verified, if the
   * surrounding context contains misTopicKeywords we flag that separately.
   */
  consistencyCheck: ConsistencyCheck;
}

export interface VerificationUnverified {
  status: "unverified";
  claim: StructuredClaim;
  /** Why we couldn't verify. One of a small, enumerable set of reasons. */
  reason:
    | "not-in-registry"
    | "registry-entry-not-human-verified"
    | "quote-verification-not-supported-yet"
    | "quote-does-not-match-verified-text"
    | "unparseable-citation";
  /** Human-readable explanation for audit reports / warnings. */
  detail: string;
  /** If not-in-registry: the parsed canonical form so a human can add it. */
  parsedCanonical?: string;
}

export interface VerificationConflict {
  status: "conflict";
  claim: StructuredClaim;
  /** The registry entry we matched against, but which conflicts. */
  matchedEntry: CitationEntry;
  /** What the conflict is about. */
  conflict:
    | "mis-topic-keyword-detected"
    | "jurisdiction-mismatch"
    | "claim-kind-mismatch";
  detail: string;
}

export interface ConsistencyCheck {
  /** Did surrounding context contain any misTopicKeywords? */
  misTopicHits: string[];
  /** Did surrounding context contain any topicKeywords (positive signal)? */
  topicKeywordHits: string[];
}

// ── Parser ─────────────────────────────────────────────────────────────────
//
// The parser normalizes common citation forms to a canonical form that
// matches what the registry stores. It intentionally rejects anything it
// doesn't recognize — we never "best-effort" interpret a citation.

/**
 * Normalize a raw citation string so it matches the registry's canonical
 * form. Returns null if the string doesn't look like a citation we can
 * confidently parse.
 *
 * Accepted shapes (after whitespace normalization):
 *   - "47 U.S.C. § 227(b)(1)(A)(iii)"
 *   - "47 USC 227(b)(1)(A)(iii)"
 *   - "47 U.S.C. Section 227(c)(5)"  → "47 U.S.C. § 227(c)(5)"
 *   - "47 C.F.R. § 64.1200(c)(2)"
 *   - "47 CFR 64.1200(c)(2)"
 *   - "La. R.S. 45:844.14"
 *   - "Facebook, Inc. v. Duguid, 141 S. Ct. 1163 (2021)"
 *   - "TCPA 227(c)(5)"
 *
 * Anything else — including bare numbers, hash-style citations, or obviously
 * malformed strings — returns null. The safer default is "we can't parse
 * this" than "we'll guess."
 */
export function normalizeCitation(raw: string): string | null {
  if (!raw) return null;
  let s = raw.trim();

  // Collapse whitespace. DO NOT strip punctuation — "§ 227(c)(5)" depends on
  // the § and parens to be meaningful.
  s = s.replace(/\s+/g, " ");

  // Replace "Section" or "Sec." with § (U.S. Code + C.F.R. style).
  s = s.replace(/\bSection\b/g, "§").replace(/\bSec\.\b/g, "§");

  // Normalize U.S.C. / USC / U.S.C — all spellings → "U.S.C." (canonical).
  //
  // IMPORTANT: we cannot use a trailing \b here. "U.S.C." ends in a dot,
  // which is a non-word character; the dot-space boundary fails \b and the
  // engine backtracks to "U.S.C" (no dot), then our replacement "U.S.C."
  // is inserted before the original dot, producing "U.S.C..". The lookahead
  // form below matches the dot when present and refuses to match inside a
  // larger word, without triggering the backtrack bug.
  s = s.replace(/\bU\.?\s*S\.?\s*C\.?(?=\s|$|[,;:§])/g, "U.S.C.");
  s = s.replace(/\bC\.?\s*F\.?\s*R\.?(?=\s|$|[,;:§])/g, "C.F.R.");

  // Insert the non-breaking "§" before a bare "227(...)" or "64.1200(...)"
  // if the user wrote "47 U.S.C. 227(b)" without the section symbol.
  s = s.replace(/\bU\.S\.C\.\s+(\d)/, "U.S.C. § $1");
  s = s.replace(/\bC\.F\.R\.\s+(\d)/, "C.F.R. § $1");

  // Collapse accidental double-§.
  s = s.replace(/§\s*§/g, "§");

  return s;
}

// ── Core verifier entrypoint ──────────────────────────────────────────────

/**
 * Verify a structured claim against the registry.
 *
 * The verifier is DELIBERATELY conservative:
 *   - "verified" means: the citation is in the registry AND the registry
 *     entry is human-verified AND no misTopicKeywords appeared in context.
 *   - "unverified" is returned for anything short of that.
 *   - "conflict" is returned when we found a match but surrounding context
 *     contradicts what the registry says the subsection is about.
 *
 * Callers MUST treat "unverified" and "conflict" as non-passing — they should
 * either block the filing, strip the citation, or require an explicit human
 * override before display.
 */
export function verifyClaim(claim: StructuredClaim): VerificationResult {
  const normalized = normalizeCitation(claim.rawCitation);
  if (!normalized) {
    return {
      status: "unverified",
      claim,
      reason: "unparseable-citation",
      detail:
        `Could not parse "${claim.rawCitation}" as a citation. Rejected by ` +
        "the verifier — upstream callers must provide a recognizable form.",
    };
  }

  const entry = findRegistryEntry(normalized);
  if (!entry) {
    return {
      status: "unverified",
      claim,
      reason: "not-in-registry",
      detail:
        `Citation "${normalized}" is not in the citation registry. The ` +
        "verifier refuses to mark unregistered citations as valid even if " +
        "they look correct — a human must add an entry to statuteRegistry.ts.",
      parsedCanonical: normalized,
    };
  }

  // Consistency check: does surrounding context contradict what the entry
  // says the subsection is about? Even if the entry is human-verified, a
  // mis-topic hit means the *usage* is wrong even though the citation is
  // real.
  const consistency = checkConsistency(entry, claim);
  if (consistency.misTopicHits.length > 0) {
    return {
      status: "conflict",
      claim,
      matchedEntry: entry,
      conflict: "mis-topic-keyword-detected",
      detail:
        `Citation "${entry.canonical}" matched the registry, but the ` +
        `surrounding context contains mis-topic keywords: ` +
        `[${consistency.misTopicHits.join(", ")}]. This typically means the ` +
        `citation is being used to support a claim it does not actually ` +
        `support. Re-read the entry's primary source and either fix the ` +
        `citation or fix the surrounding claim.`,
    };
  }

  // Quote claims require a verifiedQuote in the registry. We don't fuzzy-
  // match — exact substring presence is the test, because a paraphrase is
  // not a quote.
  if (claim.kind === "quote") {
    const verifiedQuote = entry.verification.verifiedQuote ?? null;
    if (!verifiedQuote) {
      return {
        status: "unverified",
        claim,
        reason: "quote-verification-not-supported-yet",
        detail:
          `Quote claim cites "${entry.canonical}" but the registry entry ` +
          `has no verifiedQuote. A human must paste a verbatim quote from ` +
          `the primary source into the registry before quote verification ` +
          `is possible.`,
      };
    }
    // Check: is the claim's quote a substring of the verified quote (or
    // vice versa, within reason)? We normalize whitespace on both sides.
    const claimQuoteNorm = claim.quote.replace(/\s+/g, " ").trim();
    const verifiedNorm = verifiedQuote.replace(/\s+/g, " ").trim();
    const present = verifiedNorm.includes(claimQuoteNorm);
    if (!present) {
      return {
        status: "unverified",
        claim,
        reason: "quote-does-not-match-verified-text",
        detail:
          `Quote claim for "${entry.canonical}" does not appear in the ` +
          `registry's verifiedQuote. Either the quote is inaccurate or the ` +
          `registry's verified quote is too short — a human must reconcile.`,
      };
    }
    // Quote passes the substring check — fall through to verified.
  }

  // Final trust gate: is the entry itself human-verified?
  if (entry.verification.status !== "verified") {
    return {
      status: "unverified",
      claim,
      reason: "registry-entry-not-human-verified",
      detail:
        `Citation "${entry.canonical}" is in the registry, but the entry's ` +
        `verification.status is "${entry.verification.status}". A human must ` +
        `open the primary source (${entry.primarySourceUrl}), confirm the ` +
        `citation and topic summary, and flip the status to "verified" ` +
        `with their name and the ISO date. Until then, this citation is ` +
        `not trusted.`,
    };
  }

  return {
    status: "verified",
    claim,
    matchedEntry: entry,
    matchedVia:
      entry.canonical.toLowerCase() === normalized.toLowerCase()
        ? "canonical"
        : "alias",
    consistencyCheck: consistency,
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────

function checkConsistency(
  entry: CitationEntry,
  claim: StructuredClaim,
): ConsistencyCheck {
  // Only StatuteClaim carries a surrounding-context window. QuoteClaim has
  // the quote itself, which serves double-duty for context matching.
  const raw = claim.kind === "quote" ? claim.quote : claim.context ?? "";
  const context = raw.toLowerCase();
  const topicKeywordHits: string[] = [];
  const misTopicHits: string[] = [];

  for (const kw of entry.topicKeywords) {
    if (context.includes(kw.toLowerCase())) topicKeywordHits.push(kw);
  }
  for (const kw of entry.misTopicKeywords ?? []) {
    if (context.includes(kw.toLowerCase())) misTopicHits.push(kw);
  }
  return { topicKeywordHits, misTopicHits };
}

// ── Batch-mode verification ───────────────────────────────────────────────

export interface BatchVerificationReport {
  total: number;
  verified: number;
  unverified: number;
  conflicts: number;
  results: VerificationResult[];
  /** Ready-to-display summary string (for server logs or audit output). */
  summary: string;
}

export function verifyBatch(claims: StructuredClaim[]): BatchVerificationReport {
  const results = claims.map(verifyClaim);
  let verified = 0;
  let unverified = 0;
  let conflicts = 0;
  for (const r of results) {
    if (r.status === "verified") verified++;
    else if (r.status === "conflict") conflicts++;
    else unverified++;
  }
  const summary =
    `Verifier ran over ${claims.length} claims: ` +
    `${verified} verified, ${unverified} unverified, ${conflicts} conflicts.`;
  return { total: claims.length, verified, unverified, conflicts, results, summary };
}

// ── Classification helpers for callers ────────────────────────────────────

/**
 * Given a batch report, does it meet a "safe to file" bar? The answer is
 * conservative: any non-verified result fails the bar. Callers that want
 * a softer standard should inspect the results directly.
 */
export function isSafeToFile(report: BatchVerificationReport): boolean {
  return report.unverified === 0 && report.conflicts === 0;
}

/**
 * Generate a short, plain-English explanation the filing gate can surface to
 * the user when a batch fails verification. Avoids legalese — written for a
 * 90-year-old opening the app for the first time.
 */
export function plainEnglishFailureMessage(report: BatchVerificationReport): string {
  if (isSafeToFile(report)) {
    return "All legal citations in your filing were verified.";
  }
  const parts: string[] = [];
  if (report.conflicts > 0) {
    parts.push(
      `${report.conflicts} citation(s) don't match what the statute is ` +
      `actually about. This usually means a wrong subsection number.`,
    );
  }
  if (report.unverified > 0) {
    parts.push(
      `${report.unverified} citation(s) haven't been checked against the ` +
      `real statute yet. We won't guess — a person has to verify each one ` +
      `before your filing goes out.`,
    );
  }
  return (
    "We found problems with the legal citations in your filing:\n\n" +
    parts.map((p) => "• " + p).join("\n\n") +
    "\n\nYour filing cannot be sent yet. Ask a grandkid, a paralegal, or a " +
    "lawyer to check these before you sign."
  );
}
