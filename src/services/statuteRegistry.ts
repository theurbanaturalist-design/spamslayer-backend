// ─────────────────────────────────────────────────────────────────────────────
//  statuteRegistry.ts — The authoritative list of every legal citation this
//  codebase claims to know about.
//
//  PHILOSOPHY (READ THIS BEFORE EDITING):
//
//  SpamSlayer generates legal assistance. A fabricated or typo'd citation in a
//  sworn filing is a real sanction risk (see Mata v. Avianca, 678 F. Supp. 3d
//  443 (S.D.N.Y. 2023) — lawyers sanctioned for ChatGPT-invented citations).
//
//  This registry is the *single source of truth* for "what citations does
//  SpamSlayer claim exist?" If a citation is not in this registry, the verifier
//  refuses to let it through — even if it looks correct, even if I wrote it in
//  the petition template, even if it's the most famous TCPA subsection.
//
//  Each entry is DELIBERATELY conservative. It records:
//    • the citation string in canonical form
//    • a short topic summary of what that subsection addresses
//    • a primary-source URL so a human can verify
//    • a verificationStatus — "unverified" by default. Flipping it to
//      "verified" is a human action, not an AI action. Do not flip a flag
//      unless you have personally read the text at the primary source URL
//      and confirmed (a) the subsection exists, (b) the topic summary is
//      accurate, and (c) the verbatim quote (if any) matches.
//
//  IMPORTANT — WHAT THIS REGISTRY DOES NOT CLAIM TO DO:
//    • It does not store the full text of any statute. We cannot reach the
//      GPO, Cornell LII, or eCFR from the build environment (all blocked by
//      egress). We do not retype statutes from memory — that's the exact
//      hallucination path we're trying to close.
//    • It does not adjudicate whether the topic summary is legally correct.
//      A human-verified flag is the only thing that makes a topic claim
//      trustworthy.
//
//  HOW TO VERIFY AN ENTRY:
//    1. Open the primary-source URL.
//    2. Find the exact subsection cited.
//    3. Read what it actually says.
//    4. Confirm the topic summary in this file is accurate.
//    5. If correct: update the entry — set verification.status = "verified",
//       fill in verifiedBy (your name), verifiedAt (ISO date), and optionally
//       verifiedQuote (a short verbatim snippet from the section).
//    6. If incorrect: DO NOT verify. Fix the topic summary, and leave the
//       status as "unverified" for a second person to confirm the fix.
//
//  HOW THE REGISTRY IS USED:
//    • citationVerifier.ts looks up citations against this registry.
//    • Filing packages run through the verifier before being shown to the
//      user. Unverified citations become a blocking warning.
//    • The audit script (citationAudit.ts) scans the codebase for any
//      citation that isn't registered here.
// ─────────────────────────────────────────────────────────────────────────────

export type Jurisdiction =
  | "federal-statute"   // U.S. Code
  | "federal-regulation" // C.F.R.
  | "federal-public-law" // Pub. L.
  | "federal-case"       // Reported federal decision
  | "state-statute"      // State code citation
  | "state-rule";        // State procedural rule

export interface CitationVerification {
  status: "unverified" | "verified" | "rejected";
  // Who verified. A human name. "claude" / "AI" is never a valid value.
  verifiedBy?: string;
  // ISO 8601 date (YYYY-MM-DD) of verification.
  verifiedAt?: string;
  // Short verbatim quote from the primary source, to lock in what text was
  // actually read. Keep under 500 chars to stay within fair-use comfort.
  verifiedQuote?: string;
  // If rejected: why. If verified: optional notes for the next reviewer.
  notes?: string;
}

export interface CitationEntry {
  // Canonical citation string (e.g. "47 U.S.C. § 227(b)(1)(A)(iii)").
  // The parser normalizes incoming raw citations to this form before lookup.
  canonical: string;
  // Human-readable alternatives the parser should also accept.
  // E.g. "47 USC 227(b)(1)(A)(iii)" or "TCPA 227(c)(5)".
  aliases: string[];
  jurisdiction: Jurisdiction;
  // What this subsection is about, in one sentence. Used by the verifier to
  // check that a filing's claim ("§ 227(b)(1)(A)(iii) — cellular lines") is
  // consistent with what the subsection actually addresses.
  topic: string;
  // URL to an authoritative primary source. Prefer .gov domains. Cornell LII
  // is acceptable if no government link exists.
  primarySourceUrl: string;
  // Keywords that should appear somewhere in a correct summary/quote of this
  // subsection. Used as a weak cross-check on claimed topic consistency.
  topicKeywords: string[];
  // Common MIS-topic claims that would indicate a citation/topic mismatch.
  // E.g. for (b)(1)(A)(iii) — listing "residential" here catches the common
  // error of citing (A)(iii) for residential-line claims.
  misTopicKeywords?: string[];
  verification: CitationVerification;
  // P4.4: optional metadata for staleness / supersession tracking. The
  // filing gate can warn when an entry hasn't been re-reviewed within the
  // staleness budget (default 12 months) OR when it's been deprecated by a
  // newer ruling. Both default to undefined for backward-compat.
  /** ISO date when a human last read primary source and confirmed entry. */
  lastReviewedAt?: string;
  /** If non-null: a one-line note explaining what superseded this entry. */
  deprecatedAs?: string | null;
}

// ─── FEDERAL STATUTE: 47 U.S.C. § 227 (TCPA) ─────────────────────────────────
//
// Source-of-truth URL: https://www.law.cornell.edu/uscode/text/47/227
// (not reachable from the build environment — see philosophy note above)
//
// Topic summaries below reflect widely-cited understandings from published
// federal opinions and model complaint templates. They are NOT a substitute
// for reading the statute. All entries default to "unverified" — a human
// must read the statute and confirm before the verified flag flips.

const TCPA_URL = "https://www.law.cornell.edu/uscode/text/47/227";

const FEDERAL_STATUTES: CitationEntry[] = [
  {
    canonical: "47 U.S.C. § 227",
    aliases: ["47 USC 227", "47 U.S.C. 227", "TCPA", "Section 227"],
    jurisdiction: "federal-statute",
    topic:
      "Telephone Consumer Protection Act — the federal statute governing " +
      "autodialed, prerecorded, and do-not-call telephone solicitations.",
    primarySourceUrl: TCPA_URL,
    topicKeywords: ["TCPA", "telephone", "consumer protection"],
    verification: { status: "unverified" },
  },
  {
    canonical: "47 U.S.C. § 227(a)",
    aliases: ["47 USC 227(a)", "§ 227(a)"],
    jurisdiction: "federal-statute",
    topic: "Definitions used throughout 47 U.S.C. § 227 (including the " +
      "definition of 'automatic telephone dialing system' and related terms).",
    primarySourceUrl: TCPA_URL + "#a",
    topicKeywords: ["definitions"],
    verification: { status: "unverified" },
  },
  {
    canonical: "47 U.S.C. § 227(b)",
    aliases: ["47 USC 227(b)", "§ 227(b)", "Section 227(b)"],
    jurisdiction: "federal-statute",
    topic:
      "Restrictions on use of automated telephone equipment — the ATDS and " +
      "artificial-or-prerecorded-voice prohibitions.",
    primarySourceUrl: TCPA_URL + "#b",
    topicKeywords: ["automated", "prerecorded", "ATDS", "autodialer"],
    verification: { status: "unverified" },
  },
  {
    canonical: "47 U.S.C. § 227(b)(1)",
    aliases: ["47 USC 227(b)(1)", "§ 227(b)(1)"],
    jurisdiction: "federal-statute",
    topic:
      "The general prohibition on making calls using any automatic telephone " +
      "dialing system or an artificial or prerecorded voice without required " +
      "consent (scope of lines specified in subparagraphs).",
    primarySourceUrl: TCPA_URL + "#b_1",
    topicKeywords: ["automatic telephone dialing system", "prerecorded voice"],
    verification: { status: "unverified" },
  },
  {
    canonical: "47 U.S.C. § 227(b)(1)(A)(iii)",
    aliases: ["47 USC 227(b)(1)(A)(iii)", "§ 227(b)(1)(A)(iii)"],
    jurisdiction: "federal-statute",
    topic:
      "Prohibits making any call (other than for emergency purposes or with " +
      "prior express consent) using any ATDS or artificial or prerecorded " +
      "voice to any telephone number assigned to a paging service, cellular " +
      "telephone service, specialized mobile radio service, or other radio " +
      "common carrier service, or any service for which the called party is " +
      "charged for the call.",
    primarySourceUrl: TCPA_URL + "#b_1_A_iii",
    topicKeywords: ["cellular", "paging", "charged for the call", "ATDS"],
    misTopicKeywords: ["residential"], // (A)(iii) is NOT residential — (B) is.
    verification: { status: "unverified" },
  },
  {
    canonical: "47 U.S.C. § 227(b)(1)(B)",
    aliases: ["47 USC 227(b)(1)(B)", "§ 227(b)(1)(B)"],
    jurisdiction: "federal-statute",
    topic:
      "Prohibits initiating any telephone call to any residential telephone " +
      "line using an artificial or prerecorded voice to deliver a message " +
      "without the prior express consent of the called party (subject to FCC " +
      "exemptions).",
    primarySourceUrl: TCPA_URL + "#b_1_B",
    topicKeywords: ["residential", "artificial or prerecorded voice"],
    misTopicKeywords: ["cellular only", "paging"],
    verification: { status: "unverified" },
  },
  {
    canonical: "47 U.S.C. § 227(b)(3)",
    aliases: ["47 USC 227(b)(3)", "§ 227(b)(3)"],
    jurisdiction: "federal-statute",
    topic:
      "Private right of action for violations of § 227(b) or regulations " +
      "thereunder — allows a person to bring an action in state court for " +
      "injunctive relief, actual monetary loss or $500 statutory damages per " +
      "violation (whichever is greater), or both.",
    primarySourceUrl: TCPA_URL + "#b_3",
    topicKeywords: ["private right of action", "$500", "statutory damages"],
    verification: { status: "unverified" },
  },
  {
    canonical: "47 U.S.C. § 227(b)(3)(B)",
    aliases: ["47 USC 227(b)(3)(B)", "§ 227(b)(3)(B)"],
    jurisdiction: "federal-statute",
    topic:
      "Specifies the $500 statutory damages remedy under the § 227(b) private " +
      "right of action.",
    primarySourceUrl: TCPA_URL + "#b_3_B",
    topicKeywords: ["$500", "statutory damages"],
    verification: { status: "unverified" },
  },
  {
    canonical: "47 U.S.C. § 227(c)",
    aliases: ["47 USC 227(c)", "§ 227(c)", "Section 227(c)"],
    jurisdiction: "federal-statute",
    topic:
      "Protection of subscriber privacy rights — the statutory basis for the " +
      "National Do Not Call Registry and the FCC's implementing rules at 47 " +
      "C.F.R. § 64.1200(c).",
    primarySourceUrl: TCPA_URL + "#c",
    topicKeywords: ["do not call", "subscriber privacy", "registry"],
    verification: { status: "unverified" },
  },
  {
    canonical: "47 U.S.C. § 227(c)(5)",
    aliases: ["47 USC 227(c)(5)", "§ 227(c)(5)"],
    jurisdiction: "federal-statute",
    topic:
      "Private right of action for a person who has received more than one " +
      "telephone call within any 12-month period by or on behalf of the same " +
      "entity in violation of the regulations prescribed under § 227(c). " +
      "Allows suit in state court for actual monetary loss or $500 per " +
      "violation (whichever is greater), or both, plus trebling for willful " +
      "or knowing violations.",
    primarySourceUrl: TCPA_URL + "#c_5",
    topicKeywords: ["more than one", "12-month", "private right of action", "$500"],
    verification: { status: "unverified" },
  },
  {
    canonical: "47 U.S.C. § 227(c)(5)(B)",
    aliases: ["47 USC 227(c)(5)(B)", "§ 227(c)(5)(B)"],
    jurisdiction: "federal-statute",
    topic:
      "Remedy clause for the § 227(c)(5) private right of action — $500 per " +
      "violation, or actual damages, whichever is greater; court may treble " +
      "for willful or knowing violations.",
    primarySourceUrl: TCPA_URL + "#c_5_B",
    topicKeywords: ["$500", "treble", "willful", "knowing"],
    verification: { status: "unverified" },
  },
];

// ─── FEDERAL REGULATIONS: 47 C.F.R. § 64.1200 and § 64.6305 ──────────────────

const CFR_64_1200_URL =
  "https://www.ecfr.gov/current/title-47/chapter-I/subchapter-B/part-64/" +
  "subpart-L/section-64.1200";
const CFR_64_6305_URL =
  "https://www.ecfr.gov/current/title-47/chapter-I/subchapter-B/part-64/" +
  "subpart-HH/section-64.6305";
const FTC_TSR_URL =
  "https://www.ecfr.gov/current/title-16/chapter-I/subchapter-C/part-310";

const FEDERAL_REGULATIONS: CitationEntry[] = [
  {
    canonical: "47 C.F.R. § 64.1200(a)(1)(i)",
    aliases: ["47 CFR 64.1200(a)(1)(i)", "§ 64.1200(a)(1)(i)"],
    jurisdiction: "federal-regulation",
    topic:
      "Restricts use of autodialers/prerecorded voice for solicitation calls " +
      "to emergency telephone lines. (Note: the 8am–9pm calling-hours rule " +
      "for telephone solicitations is at § 64.1200(c)(1), NOT (a)(1)(i). " +
      "Verify before flipping to 'verified'.)",
    primarySourceUrl: CFR_64_1200_URL + "#p-64.1200(a)(1)(i)",
    topicKeywords: ["emergency telephone lines"],
    misTopicKeywords: ["8 AM", "9 PM", "calling hours"],
    verification: {
      status: "unverified",
      notes:
        "POSSIBLY MISCITED IN CODEBASE: the current codebase cites " +
        "§ 64.1200(a)(1)(i) as the 8am–9pm calling-hours rule. That rule is " +
        "commonly understood to be at § 64.1200(c)(1). A human must verify " +
        "and, if miscited, the codebase must be corrected before this entry " +
        "is used as 'verified'.",
    },
  },
  {
    canonical: "47 C.F.R. § 64.1200(c)",
    aliases: ["47 CFR 64.1200(c)", "§ 64.1200(c)"],
    jurisdiction: "federal-regulation",
    topic:
      "Do-Not-Call protections for residential subscribers, including the " +
      "calling-hours window and the National Do-Not-Call Registry.",
    primarySourceUrl: CFR_64_1200_URL + "#p-64.1200(c)",
    topicKeywords: ["do not call", "residential subscriber"],
    verification: { status: "unverified" },
  },
  {
    canonical: "47 C.F.R. § 64.1200(c)(2)",
    aliases: ["47 CFR 64.1200(c)(2)", "§ 64.1200(c)(2)"],
    jurisdiction: "federal-regulation",
    topic:
      "Prohibits telephone solicitations to residential subscribers who have " +
      "registered their number on the National Do-Not-Call Registry (with " +
      "exceptions for established business relationships, express written " +
      "invitation or permission, etc.) — including the 31-day post-" +
      "registration effectiveness rule.",
    primarySourceUrl: CFR_64_1200_URL + "#p-64.1200(c)(2)",
    topicKeywords: ["do not call registry", "31 days", "established business relationship"],
    verification: { status: "unverified" },
  },
  {
    canonical: "47 C.F.R. § 64.1200(f)(5)",
    aliases: ["47 CFR 64.1200(f)(5)", "§ 64.1200(f)(5)"],
    jurisdiction: "federal-regulation",
    topic:
      "Definition of 'established business relationship' for purposes of the " +
      "DNC Registry rules.",
    primarySourceUrl: CFR_64_1200_URL + "#p-64.1200(f)(5)",
    topicKeywords: ["established business relationship", "EBR"],
    verification: { status: "unverified" },
  },
  {
    canonical: "47 C.F.R. § 64.1200(f)(5)(iii)(B)",
    aliases: ["47 CFR 64.1200(f)(5)(iii)(B)", "§ 64.1200(f)(5)(iii)(B)"],
    jurisdiction: "federal-regulation",
    topic:
      "Provision within the EBR definition addressing inquiry-based relationships.",
    primarySourceUrl: CFR_64_1200_URL + "#p-64.1200(f)(5)(iii)(B)",
    topicKeywords: ["inquiry", "established business relationship"],
    verification: {
      status: "unverified",
      notes:
        "Deep subsection — particularly important to read the actual text " +
        "before flipping to verified, since the codebase makes a specific " +
        "claim about what 'inquiry' requires.",
    },
  },
  {
    canonical: "47 C.F.R. § 64.1200(f)(12)",
    aliases: ["47 CFR 64.1200(f)(12)", "§ 64.1200(f)(12)"],
    jurisdiction: "federal-regulation",
    topic:
      "Definition of 'residential subscriber' (or similarly enumerated term) " +
      "within the § 64.1200 definitions. Verify exact term before use — the " +
      "paragraph numbering of (f) has been amended multiple times.",
    primarySourceUrl: CFR_64_1200_URL + "#p-64.1200(f)(12)",
    topicKeywords: ["residential subscriber", "definition"],
    verification: {
      status: "unverified",
      notes:
        "Paragraph (f) has been renumbered by FCC amendments. Confirm the " +
        "current paragraph (12) is what the codebase intends.",
    },
  },
  {
    canonical: "47 C.F.R. § 64.1200(k)",
    aliases: ["47 CFR 64.1200(k)", "§ 64.1200(k)"],
    jurisdiction: "federal-regulation",
    topic:
      "Carrier obligations for handling suspected illegal robocall traffic; " +
      "STIR/SHAKEN and traceback-related duties under post-TRACED-Act rules.",
    primarySourceUrl: CFR_64_1200_URL + "#p-64.1200(k)",
    topicKeywords: ["carrier", "traceback", "robocall"],
    verification: { status: "unverified" },
  },
  {
    canonical: "47 C.F.R. § 64.1200(n)(1)",
    aliases: ["47 CFR 64.1200(n)(1)", "§ 64.1200(n)(1)"],
    jurisdiction: "federal-regulation",
    topic: "Know-Your-Customer / caller-identification obligations.",
    primarySourceUrl: CFR_64_1200_URL + "#p-64.1200(n)(1)",
    topicKeywords: ["know your customer"],
    verification: {
      status: "unverified",
      notes:
        "Paragraph (n) was added by recent FCC amendments. Confirm current " +
        "numbering before verifying.",
    },
  },
  {
    canonical: "47 C.F.R. § 64.6305",
    aliases: ["47 CFR 64.6305", "§ 64.6305"],
    jurisdiction: "federal-regulation",
    topic:
      "STIR/SHAKEN caller ID authentication — registration and compliance " +
      "obligations for voice service providers.",
    primarySourceUrl: CFR_64_6305_URL,
    topicKeywords: ["STIR/SHAKEN", "caller id authentication"],
    verification: { status: "unverified" },
  },
  {
    canonical: "16 C.F.R. § 310",
    aliases: ["16 CFR 310", "§ 310", "Telemarketing Sales Rule", "TSR"],
    jurisdiction: "federal-regulation",
    topic:
      "FTC Telemarketing Sales Rule — the FTC's telemarketing regulations, " +
      "parallel to but distinct from the FCC's § 64.1200 regime.",
    primarySourceUrl: FTC_TSR_URL,
    topicKeywords: ["telemarketing sales rule", "FTC"],
    verification: { status: "unverified" },
  },
  {
    canonical: "16 C.F.R. § 310.4(b)(1)(iii)(B)",
    aliases: ["16 CFR 310.4(b)(1)(iii)(B)", "§ 310.4(b)(1)(iii)(B)"],
    jurisdiction: "federal-regulation",
    topic:
      "FTC Telemarketing Sales Rule provision on do-not-call list compliance " +
      "(entity-specific and national registry-based prohibitions).",
    primarySourceUrl:
      "https://www.ecfr.gov/current/title-16/chapter-I/subchapter-C/part-310/section-310.4",
    topicKeywords: ["do not call", "national do-not-call registry"],
    verification: { status: "unverified" },
  },
  {
    canonical: "47 C.F.R. § 64.1200",
    aliases: ["47 CFR 64.1200", "§ 64.1200", "47 C.F.R. Section 64.1200"],
    jurisdiction: "federal-regulation",
    topic:
      "FCC regulation implementing the TCPA — the umbrella section from " +
      "which (a), (c), (d), (f), (k), (n) subsections derive.",
    primarySourceUrl: CFR_64_1200_URL,
    topicKeywords: ["TCPA", "FCC regulation"],
    verification: { status: "unverified" },
  },
];

// ─── OTHER TITLES OF THE U.S. CODE CITED IN FILINGS ─────────────────────────
// The TCPA filing references a handful of federal statutes outside Title 47:
// false-statements (18 U.S.C. § 1001), one-party-consent recording (18 U.S.C.
// § 2511(2)(d)), federal SOL (28 U.S.C. § 1658(a)), unsworn-declaration
// perjury (28 U.S.C. § 1746), and removal/remand (28 U.S.C. § 1441/1447).
// Each gets its own registry entry so the verifier can recognize it.

const OTHER_FEDERAL_STATUTES: CitationEntry[] = [
  {
    canonical: "18 U.S.C. § 1001",
    aliases: ["18 USC 1001", "§ 1001", "18 U.S.C. Section 1001"],
    jurisdiction: "federal-statute",
    topic:
      "Federal false-statements statute — criminal penalty for knowingly " +
      "and willfully making materially false statements within the " +
      "jurisdiction of the executive, legislative, or judicial branches. " +
      "Referenced in complaint-bundle certifications (the 'penalty of " +
      "perjury' citation for FCC / CFPB complaint forms).",
    primarySourceUrl: "https://www.law.cornell.edu/uscode/text/18/1001",
    topicKeywords: ["false statement", "penalty of perjury"],
    verification: { status: "unverified" },
  },
  {
    canonical: "18 U.S.C. § 2511(2)(d)",
    aliases: ["18 USC 2511(2)(d)", "§ 2511(2)(d)"],
    jurisdiction: "federal-statute",
    topic:
      "Federal Wiretap Act one-party-consent exception — a person may record " +
      "a wire/oral/electronic communication where that person is a party to " +
      "the communication, subject to certain limitations.",
    primarySourceUrl: "https://www.law.cornell.edu/uscode/text/18/2511",
    topicKeywords: ["wiretap", "one-party consent", "interception"],
    verification: { status: "unverified" },
  },
  {
    canonical: "28 U.S.C. § 1658(a)",
    aliases: ["28 USC 1658(a)", "§ 1658(a)"],
    jurisdiction: "federal-statute",
    topic:
      "Catch-all 4-year statute of limitations for federal civil actions " +
      "arising under a federal statute enacted after December 1, 1990. " +
      "Widely applied to TCPA claims.",
    primarySourceUrl: "https://www.law.cornell.edu/uscode/text/28/1658",
    topicKeywords: ["statute of limitations", "4-year", "four-year"],
    verification: { status: "unverified" },
  },
  {
    canonical: "28 U.S.C. § 1746",
    aliases: ["28 USC 1746", "§ 1746"],
    jurisdiction: "federal-statute",
    topic:
      "Federal unsworn-declaration statute — allows a sworn statement to be " +
      "signed under penalty of perjury without a notary under specific " +
      "wording (used for pro se verification pages).",
    primarySourceUrl: "https://www.law.cornell.edu/uscode/text/28/1746",
    topicKeywords: ["unsworn declaration", "penalty of perjury"],
    verification: { status: "unverified" },
  },
  {
    canonical: "28 U.S.C. § 1441(a)",
    aliases: ["28 USC 1441(a)", "§ 1441(a)"],
    jurisdiction: "federal-statute",
    topic:
      "Federal removal statute — allows a defendant to remove certain civil " +
      "actions from state court to federal district court.",
    primarySourceUrl: "https://www.law.cornell.edu/uscode/text/28/1441",
    topicKeywords: ["removal", "federal court"],
    verification: { status: "unverified" },
  },
  {
    canonical: "28 U.S.C. § 1447(c)",
    aliases: ["28 USC 1447(c)", "§ 1447(c)"],
    jurisdiction: "federal-statute",
    topic:
      "Federal remand statute — provides for remand of a removed case when " +
      "the federal court lacks subject-matter jurisdiction, including award " +
      "of costs and fees in certain circumstances.",
    primarySourceUrl: "https://www.law.cornell.edu/uscode/text/28/1447",
    topicKeywords: ["remand", "federal court"],
    verification: { status: "unverified" },
  },
  {
    canonical: "12 U.S.C. § 5531",
    aliases: ["12 USC 5531", "§ 5531"],
    jurisdiction: "federal-statute",
    topic:
      "CFPB authority to prohibit unfair, deceptive, or abusive acts or " +
      "practices (UDAAP).",
    primarySourceUrl: "https://www.law.cornell.edu/uscode/text/12/5531",
    topicKeywords: ["CFPB", "UDAAP", "unfair", "deceptive", "abusive"],
    verification: { status: "unverified" },
  },
  {
    canonical: "12 U.S.C. § 5534",
    aliases: ["12 USC 5534", "§ 5534"],
    jurisdiction: "federal-statute",
    topic:
      "CFPB consumer-complaint response and resolution authority.",
    primarySourceUrl: "https://www.law.cornell.edu/uscode/text/12/5534",
    topicKeywords: ["CFPB", "consumer complaint"],
    verification: { status: "unverified" },
  },
];

// ─── FEDERAL PUBLIC LAWS ─────────────────────────────────────────────────────

const FEDERAL_PUBLIC_LAWS: CitationEntry[] = [
  {
    canonical: "Pub. L. 116-105",
    aliases: ["Public Law 116-105", "TRACED Act"],
    jurisdiction: "federal-public-law",
    // The TRACED Act's public-law number is widely cited as 116-105 in FCC
    // orders and law-review articles; however, I have not verified this from
    // a primary source in the build environment. A human should confirm
    // against the Statutes at Large entry before flipping.
    topic:
      "Pallone-Thune Telephone Robocall Abuse Criminal Enforcement and " +
      "Deterrence (TRACED) Act — amended the TCPA and expanded FCC " +
      "enforcement tools against illegal robocalls.",
    primarySourceUrl: "https://www.congress.gov/bill/116th-congress/senate-bill/151",
    topicKeywords: ["TRACED Act", "robocall", "enforcement"],
    verification: {
      status: "unverified",
      notes:
        "Confirm public-law number against the Statutes at Large. The TRACED " +
        "Act is sometimes cited with a different Pub. L. number in secondary " +
        "sources.",
    },
  },
];

// ─── FEDERAL CASES ───────────────────────────────────────────────────────────

const FEDERAL_CASES: CitationEntry[] = [
  {
    canonical: "Facebook, Inc. v. Duguid, 141 S. Ct. 1163 (2021)",
    aliases: [
      "Facebook v. Duguid",
      "Facebook, Inc. v. Duguid",
      "Facebook v. Duguid, 141 S. Ct. 1163 (2021)",
      "141 S. Ct. 1163",
    ],
    jurisdiction: "federal-case",
    topic:
      "Supreme Court decision narrowing the statutory definition of ATDS " +
      "under 47 U.S.C. § 227(a)(1). Held that an ATDS must use a random or " +
      "sequential number generator to either store or produce telephone " +
      "numbers to be called.",
    primarySourceUrl:
      "https://www.supremecourt.gov/opinions/20pdf/19-511_p86b.pdf",
    topicKeywords: ["ATDS", "random or sequential", "Duguid"],
    verification: { status: "unverified" },
  },
  // ── Cases below this line were surfaced by the codebase audit after the
  // regex tightening in round 19. Every entry below is a widely-cited,
  // real decision but the canonical cite string + topic summary below have
  // NOT been read against the reporter by a human on this project. They
  // default to "unverified" and are intentionally soft-warn material at the
  // filing gate rather than hard-block. A human reviewer opening the
  // reporter and flipping status to "verified" is the only way these move
  // to "known good." Until then, every filing that emits them will carry a
  // warning telling the user to have the cite double-checked.
  //
  // Source-of-truth URLs are provided for convenience. They are NOT proof
  // of verification — a human clicking through and reading is.
  {
    canonical: "Mims v. Arrow Financial Services, LLC, 565 U.S. 368 (2012)",
    aliases: [
      "Mims v. Arrow Financial Services, 565 U.S. 368 (2012)",
      "Mims v. Arrow Financial, 565 U.S. 368 (2012)",
      "Mims v. Arrow Financial Services",
      "Mims v. Arrow Financial",
      "565 U.S. 368",
    ],
    jurisdiction: "federal-case",
    topic:
      "Supreme Court decision holding that federal and state courts have " +
      "concurrent jurisdiction over private TCPA actions. Resolved a split " +
      "over whether 47 U.S.C. § 227 private suits must be filed in state " +
      "court.",
    primarySourceUrl:
      "https://www.supremecourt.gov/opinions/11pdf/10-1195.pdf",
    topicKeywords: ["concurrent jurisdiction", "TCPA", "private action"],
    verification: { status: "unverified" },
  },
  {
    canonical: "Spokeo, Inc. v. Robins, 578 U.S. 330 (2016)",
    aliases: [
      "Spokeo v. Robins",
      "Spokeo v. Robins, 578 U.S. 330 (2016)",
      "Spokeo, Inc. v. Robins",
      "578 U.S. 330",
    ],
    jurisdiction: "federal-case",
    topic:
      "Supreme Court decision on Article III standing in consumer statute " +
      "cases. Plaintiff must plead a concrete injury; a bare procedural " +
      "violation does not automatically satisfy injury-in-fact.",
    primarySourceUrl:
      "https://www.supremecourt.gov/opinions/15pdf/13-1339_f2qg.pdf",
    topicKeywords: ["standing", "concrete injury", "injury-in-fact"],
    verification: { status: "unverified" },
  },
  {
    canonical: "TransUnion LLC v. Ramirez, 594 U.S. 413 (2021)",
    aliases: [
      "TransUnion v. Ramirez",
      "TransUnion v. Ramirez, 594 U.S. 413 (2021)",
      "TransUnion LLC v. Ramirez",
      "594 U.S. 413",
    ],
    jurisdiction: "federal-case",
    topic:
      "Supreme Court decision reaffirming Spokeo: plaintiffs must show a " +
      "concrete harm for Article III standing, and a statutory violation " +
      "alone is insufficient for class members who suffered no real-world " +
      "consequence.",
    primarySourceUrl:
      "https://www.supremecourt.gov/opinions/20pdf/20-297_4g25.pdf",
    topicKeywords: ["standing", "concrete harm", "class members"],
    verification: { status: "unverified" },
  },
  {
    canonical: "Burger King Corp. v. Rudzewicz, 471 U.S. 462 (1985)",
    aliases: [
      "Burger King v. Rudzewicz",
      "Burger King Corp. v. Rudzewicz",
      "471 U.S. 462",
    ],
    jurisdiction: "federal-case",
    topic:
      "Supreme Court decision on specific personal jurisdiction. A " +
      "non-resident defendant is subject to personal jurisdiction in a " +
      "forum where it has purposefully directed activities and the cause " +
      "of action arises out of or relates to those contacts.",
    primarySourceUrl:
      "https://supreme.justia.com/cases/federal/us/471/462/",
    topicKeywords: [
      "personal jurisdiction",
      "purposeful availment",
      "minimum contacts",
    ],
    verification: { status: "unverified" },
  },
  {
    canonical: "CompuServe Inc. v. Cyber Promotions, Inc., 962 F. Supp. 1015 (S.D. Ohio 1997)",
    aliases: [
      "CompuServe v. Cyber Promotions",
      "CompuServe Inc. v. Cyber Promotions, Inc.",
      "962 F. Supp. 1015",
    ],
    jurisdiction: "federal-case",
    topic:
      "Early federal district-court decision applying trespass-to-chattels " +
      "to unsolicited commercial email overloading a commercial ISP's " +
      "servers. Cited in TCPA literature as a historical analogue for " +
      "unsolicited mass contact torts.",
    primarySourceUrl:
      "https://law.justia.com/cases/federal/district-courts/FSupp/962/1015/2303853/",
    topicKeywords: ["trespass to chattels", "spam", "unsolicited"],
    verification: { status: "unverified" },
  },
  {
    canonical: "Mata v. Avianca, Inc., 678 F. Supp. 3d 443 (S.D.N.Y. 2023)",
    aliases: [
      "Mata v. Avianca",
      "Mata v. Avianca, 678 F. Supp. 3d 443 (S.D.N.Y. 2023)",
      "Mata v. Avianca, Inc.",
      "678 F. Supp. 3d 443",
    ],
    jurisdiction: "federal-case",
    topic:
      "District court decision sanctioning attorneys who submitted a brief " +
      "containing fabricated case citations generated by an AI tool. Cited " +
      "in this codebase as the canonical risk example for AI-generated legal " +
      "filings.",
    primarySourceUrl:
      "https://casetext.com/case/mata-v-avianca-inc-2",
    topicKeywords: [
      "AI-generated",
      "fabricated citation",
      "sanction",
    ],
    verification: { status: "unverified" },
  },
  {
    canonical: "Stoops v. Wells Fargo Bank, N.A., 197 F. Supp. 3d 782 (W.D. Pa. 2016)",
    aliases: [
      "Stoops v. Wells Fargo",
      "Stoops v. Wells Fargo, 197 F. Supp. 3d 782 (W.D. Pa. 2016)",
      "Stoops v. Wells Fargo Bank, N.A.",
      "197 F. Supp. 3d 782",
    ],
    jurisdiction: "federal-case",
    topic:
      "District court decision holding that a plaintiff who purchased " +
      "cell phones for the explicit purpose of receiving TCPA-violating " +
      "calls lacks Article III standing — the statute's zone of interests " +
      "does not include manufactured-claim plaintiffs.",
    primarySourceUrl:
      "https://casetext.com/case/stoops-v-wells-fargo-bank-na-2",
    topicKeywords: [
      "standing",
      "professional plaintiff",
      "zone of interests",
    ],
    verification: { status: "unverified" },
  },
];

// ─── STATE STATUTES — keyed by the 2-letter postal code of the state ────────
//
// IMPORTANT: state citations are the riskiest area of the corpus. State codes
// renumber more often than federal code, and the short-form citation style
// varies by state. Every state entry MUST be human-verified by someone who
// has opened the state legislature's official publication.

const STATE_STATUTES: CitationEntry[] = [
  // ── Louisiana ──
  {
    canonical: "La. R.S. 45:844.14",
    aliases: ["Louisiana R.S. 45:844.14"],
    jurisdiction: "state-statute",
    topic:
      "Louisiana state Do-Not-Call statute within Title 45 (Public Utilities " +
      "and Carriers).",
    primarySourceUrl:
      "https://www.legis.la.gov/legis/LawSearchList.aspx?q=45%3A844.14",
    topicKeywords: ["do not call", "telephonic solicitation"],
    verification: { status: "unverified" },
  },
  {
    canonical: "La. R.S. 15:1303",
    aliases: ["Louisiana R.S. 15:1303"],
    jurisdiction: "state-statute",
    topic:
      "Louisiana electronic surveillance — recording consent provisions " +
      "(commonly characterized as one-party consent).",
    primarySourceUrl:
      "https://www.legis.la.gov/legis/LawSearchList.aspx?q=15%3A1303",
    topicKeywords: ["recording", "one-party consent"],
    verification: { status: "unverified" },
  },
  {
    canonical: "La. R.S. 13:5200",
    aliases: ["Louisiana R.S. 13:5200", "La. R.S. 13:5200 et seq."],
    jurisdiction: "state-statute",
    topic: "Louisiana small claims / city-court jurisdictional scheme.",
    primarySourceUrl:
      "https://www.legis.la.gov/legis/LawSearchList.aspx?q=13%3A5200",
    topicKeywords: ["small claims", "city court"],
    verification: { status: "unverified" },
  },
  {
    canonical: "La. R.S. 13:5202",
    aliases: ["Louisiana R.S. 13:5202"],
    jurisdiction: "state-statute",
    topic:
      "Louisiana small-claims jurisdictional provision within the city-" +
      "court small-claims chapter (confirm exact scope with primary source).",
    primarySourceUrl:
      "https://www.legis.la.gov/legis/LawSearchList.aspx?q=13%3A5202",
    topicKeywords: ["small claims", "jurisdiction"],
    verification: { status: "unverified" },
  },
  {
    canonical: "La. R.S. 13:5204",
    aliases: ["Louisiana R.S. 13:5204"],
    jurisdiction: "state-statute",
    topic:
      "Louisiana small-claims procedure provision within the city-court " +
      "small-claims chapter.",
    primarySourceUrl:
      "https://www.legis.la.gov/legis/LawSearchList.aspx?q=13%3A5204",
    topicKeywords: ["small claims", "procedure"],
    verification: { status: "unverified" },
  },
  {
    canonical: "La. R.S. 13:5206",
    aliases: ["Louisiana R.S. 13:5206"],
    jurisdiction: "state-statute",
    topic:
      "Louisiana small-claims provision — confirm exact scope (appeals, " +
      "judgment, or procedure) with primary source.",
    primarySourceUrl:
      "https://www.legis.la.gov/legis/LawSearchList.aspx?q=13%3A5206",
    topicKeywords: ["small claims"],
    verification: { status: "unverified" },
  },
  {
    canonical: "La. R.S. 13:5211",
    aliases: ["Louisiana R.S. 13:5211"],
    jurisdiction: "state-statute",
    topic:
      "Louisiana small-claims / city-court provision (appellate or final-" +
      "judgment-related; confirm exact scope with primary source).",
    primarySourceUrl:
      "https://www.legis.la.gov/legis/LawSearchList.aspx?q=13%3A5211",
    topicKeywords: ["city court", "small claims"],
    verification: { status: "unverified" },
  },
  {
    canonical: "La. R.S. 13:3201",
    aliases: ["Louisiana R.S. 13:3201"],
    jurisdiction: "state-statute",
    topic:
      "Louisiana long-arm statute — grounds for personal jurisdiction over " +
      "non-resident defendants.",
    primarySourceUrl:
      "https://www.legis.la.gov/legis/LawSearchList.aspx?q=13%3A3201",
    topicKeywords: ["long-arm", "personal jurisdiction", "non-resident"],
    verification: { status: "unverified" },
  },
  {
    // P3.2: city-court amount-in-dispute jurisdiction. The petition cites
    // this as the source of Lafayette City Court's authority to hear the
    // small-claims TCPA action; was missing from the registry, so the
    // citation audit was flagging it as not-in-registry.
    canonical: "La. C.C.P. Art. 4843",
    aliases: ["Louisiana C.C.P. Art. 4843", "La. C.C.P. art. 4843", "La. Code Civ. P. art. 4843"],
    jurisdiction: "state-statute",
    topic:
      "Louisiana Code of Civil Procedure Article 4843 — city court civil " +
      "jurisdiction by amount in dispute. Establishes the monetary ceiling " +
      "below which a city court (such as Lafayette City Court) has subject-" +
      "matter jurisdiction over civil actions including small-claims TCPA " +
      "suits.",
    primarySourceUrl:
      "https://www.legis.la.gov/legis/Law.aspx?d=112322",
    topicKeywords: ["city court", "jurisdiction", "amount in dispute"],
    verification: { status: "unverified" },
  },
  {
    canonical: "La. R.S. 12:308",
    aliases: ["Louisiana R.S. 12:308"],
    jurisdiction: "state-statute",
    topic:
      "Louisiana corporations statute — registered-office / service-of-" +
      "process provisions for business entities.",
    primarySourceUrl:
      "https://www.legis.la.gov/legis/LawSearchList.aspx?q=12%3A308",
    topicKeywords: ["registered office", "service of process", "corporation"],
    verification: { status: "unverified" },
  },
  {
    canonical: "La. R.S. 45:844.15",
    aliases: ["Louisiana R.S. 45:844.15"],
    jurisdiction: "state-statute",
    topic:
      "Louisiana telephonic-solicitation statute — companion/adjacent to " +
      "§ 844.14 (penalties / private right of action).",
    primarySourceUrl:
      "https://www.legis.la.gov/legis/LawSearchList.aspx?q=45%3A844.15",
    topicKeywords: ["telephonic solicitation", "private action"],
    verification: { status: "unverified" },
  },

  // ── California ──
  {
    canonical: "Cal. Bus. & Prof. Code § 17592",
    aliases: ["California Business & Professions Code 17592"],
    jurisdiction: "state-statute",
    topic: "California's adoption of the federal Do-Not-Call Registry regime.",
    primarySourceUrl:
      "https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?sectionNum=17592&lawCode=BPC",
    topicKeywords: ["do not call", "national do not call list"],
    verification: { status: "unverified" },
  },
  {
    canonical: "Cal. Penal Code § 632",
    aliases: ["California Penal Code 632"],
    jurisdiction: "state-statute",
    topic:
      "California all-party (two-party) consent recording statute — makes " +
      "it criminal to record a confidential communication without the " +
      "consent of all parties.",
    primarySourceUrl:
      "https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?sectionNum=632&lawCode=PEN",
    topicKeywords: ["two-party consent", "confidential communication"],
    verification: { status: "unverified" },
  },
  {
    canonical: "Cal. Code Civ. Proc. § 116.110",
    aliases: ["CCP 116.110", "Cal. CCP 116.110", "Cal. Code Civ. Proc. § 116.110 et seq."],
    jurisdiction: "state-statute",
    topic: "California Small Claims Act — jurisdictional limits and procedure.",
    primarySourceUrl:
      "https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?sectionNum=116.110&lawCode=CCP",
    topicKeywords: ["small claims"],
    verification: { status: "unverified" },
  },

  // ── Texas ──
  {
    canonical: "Tex. Bus. & Com. Code § 304.001",
    aliases: ["Tex. Bus. & Com. Code § 304.001 et seq."],
    jurisdiction: "state-statute",
    topic: "Texas state Do-Not-Call list statute (Chapter 304).",
    primarySourceUrl:
      "https://statutes.capitol.texas.gov/Docs/BC/htm/BC.304.htm",
    topicKeywords: ["do not call", "Texas"],
    verification: { status: "unverified" },
  },
  {
    canonical: "Tex. Penal Code § 16.02",
    aliases: ["Texas Penal Code 16.02"],
    jurisdiction: "state-statute",
    topic: "Texas unlawful interception/recording statute (one-party consent).",
    primarySourceUrl:
      "https://statutes.capitol.texas.gov/Docs/PE/htm/PE.16.htm",
    topicKeywords: ["interception", "recording", "one-party consent"],
    verification: { status: "unverified" },
  },
  {
    canonical: "Tex. Gov't Code § 27.031",
    aliases: ["Texas Government Code 27.031"],
    jurisdiction: "state-statute",
    topic: "Texas justice court jurisdiction (small claims-style venue).",
    primarySourceUrl:
      "https://statutes.capitol.texas.gov/Docs/GV/htm/GV.27.htm",
    topicKeywords: ["justice court", "jurisdiction"],
    verification: { status: "unverified" },
  },

  // ── New York ──
  {
    canonical: "N.Y. Gen. Bus. Law § 399-z",
    aliases: ["New York General Business Law 399-z"],
    jurisdiction: "state-statute",
    topic:
      "New York telemarketing / Do-Not-Call related General Business Law " +
      "provision.",
    primarySourceUrl:
      "https://www.nysenate.gov/legislation/laws/GBS/399-Z",
    topicKeywords: ["telemarketing", "do not call"],
    verification: {
      status: "unverified",
      notes:
        "Section designator with -z is unusual; verify the exact letter " +
        "against the official statute before use. NY has had renumbered " +
        "telemarketing sections in recent years.",
    },
  },
  {
    canonical: "N.Y. Penal Law § 250.00",
    aliases: ["New York Penal Law 250.00"],
    jurisdiction: "state-statute",
    topic:
      "New York eavesdropping/recording definitions (one-party consent).",
    primarySourceUrl:
      "https://www.nysenate.gov/legislation/laws/PEN/250.00",
    topicKeywords: ["eavesdropping", "one-party consent"],
    verification: { status: "unverified" },
  },
  {
    canonical: "N.Y. Uniform City Court Act art. 18",
    aliases: ["NY UCCA article 18"],
    jurisdiction: "state-rule",
    topic: "New York Uniform City Court Act small claims procedures.",
    primarySourceUrl:
      "https://www.nysenate.gov/legislation/laws/UCT/A18",
    topicKeywords: ["small claims", "uniform city court"],
    verification: { status: "unverified" },
  },

  // ── Florida ──
  {
    canonical: "Fla. Stat. § 501.059",
    aliases: ["Florida Statutes 501.059"],
    jurisdiction: "state-statute",
    topic:
      "Florida Telemarketing Act / Do-Not-Call provisions (amended 2021 — " +
      "the 'Mini-TCPA' amendments — significant private right of action).",
    primarySourceUrl:
      "http://www.leg.state.fl.us/statutes/index.cfm?App_mode=Display_Statute&URL=0500-0599/0501/Sections/0501.059.html",
    topicKeywords: ["telemarketing", "do not call", "mini-TCPA"],
    verification: {
      status: "unverified",
      notes:
        "Florida's § 501.059 was significantly amended in 2021 and again in " +
        "2023. Confirm the current version and any amendments before use in " +
        "a sworn filing.",
    },
  },
  {
    canonical: "Fla. Stat. § 934.03",
    aliases: ["Florida Statutes 934.03"],
    jurisdiction: "state-statute",
    topic:
      "Florida interception-of-communications statute (two-party consent for " +
      "recording oral communications in Florida).",
    primarySourceUrl:
      "http://www.leg.state.fl.us/statutes/index.cfm?App_mode=Display_Statute&URL=0900-0999/0934/Sections/0934.03.html",
    topicKeywords: ["interception", "two-party consent"],
    verification: { status: "unverified" },
  },

  // ── Georgia ──
  {
    canonical: "Ga. Code Ann. § 46-5-27",
    aliases: ["Georgia Code 46-5-27"],
    jurisdiction: "state-statute",
    topic:
      "Georgia telephone-solicitation / Do-Not-Call list provision within " +
      "Title 46 (Public Utilities).",
    primarySourceUrl:
      "https://law.justia.com/codes/georgia/2022/title-46/chapter-5/article-1/section-46-5-27/",
    topicKeywords: ["telephone solicitation", "do not call"],
    verification: { status: "unverified" },
  },
  {
    canonical: "Ga. Code Ann. § 16-11-66",
    aliases: ["Georgia Code 16-11-66"],
    jurisdiction: "state-statute",
    topic:
      "Georgia recording/eavesdropping consent statute (one-party consent).",
    primarySourceUrl:
      "https://law.justia.com/codes/georgia/2022/title-16/chapter-11/article-3/part-1/section-16-11-66/",
    topicKeywords: ["eavesdropping", "one-party consent"],
    verification: { status: "unverified" },
  },
  {
    canonical: "Ga. Code Ann. § 15-10-2",
    aliases: ["Georgia Code 15-10-2"],
    jurisdiction: "state-statute",
    topic: "Georgia magistrate court jurisdiction (small-claims-style).",
    primarySourceUrl:
      "https://law.justia.com/codes/georgia/2022/title-15/chapter-10/article-1/section-15-10-2/",
    topicKeywords: ["magistrate court", "jurisdiction", "small claims"],
    verification: { status: "unverified" },
  },
];

// ─── The master registry ────────────────────────────────────────────────────

export const CITATION_REGISTRY: CitationEntry[] = [
  ...FEDERAL_STATUTES,
  ...OTHER_FEDERAL_STATUTES,
  ...FEDERAL_REGULATIONS,
  ...FEDERAL_PUBLIC_LAWS,
  ...FEDERAL_CASES,
  ...STATE_STATUTES,
];

// Quick-lookup map keyed by canonical form (case-insensitive).
const BY_CANONICAL: Map<string, CitationEntry> = new Map();
for (const e of CITATION_REGISTRY) {
  BY_CANONICAL.set(e.canonical.toLowerCase(), e);
}

// Alias lookup — maps every alias to the canonical entry.
const BY_ALIAS: Map<string, CitationEntry> = new Map();
for (const e of CITATION_REGISTRY) {
  for (const alias of e.aliases) {
    BY_ALIAS.set(alias.toLowerCase(), e);
  }
}

/**
 * Look up a citation in the registry. Matches against both canonical form
 * and any declared alias. Case-insensitive. Returns null if not registered.
 *
 * This is the trust boundary: if a citation is NOT in the registry, the
 * verifier must not treat it as known-valid, regardless of how plausible
 * it looks.
 */
export function findRegistryEntry(citation: string): CitationEntry | null {
  const key = citation.trim().toLowerCase();
  return BY_CANONICAL.get(key) ?? BY_ALIAS.get(key) ?? null;
}

/**
 * Returns the full registry. Used by the audit tool.
 */
export function listAllEntries(): CitationEntry[] {
  return [...CITATION_REGISTRY];
}

/**
 * Count of how many registry entries are human-verified. The filing gate
 * can use this to warn if the registry is mostly unverified.
 */
export function verificationSummary(): {
  total: number;
  verified: number;
  unverified: number;
  rejected: number;
} {
  let verified = 0;
  let unverified = 0;
  let rejected = 0;
  for (const e of CITATION_REGISTRY) {
    if (e.verification.status === "verified") verified++;
    else if (e.verification.status === "rejected") rejected++;
    else unverified++;
  }
  return {
    total: CITATION_REGISTRY.length,
    verified,
    unverified,
    rejected,
  };
}
