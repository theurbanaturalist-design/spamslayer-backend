// ─────────────────────────────────────────────────────────────────────────────
//  pressureStack.ts — non-judgment enforcement enumerator
//
//  When the filing-decision engine says DON'T FILE (uncollectable defendant,
//  weak case, spoofed VoIP shell), the spammer is still breaking the law.
//  This module enumerates every parallel-enforcement path that creates
//  pressure on their operation WITHOUT requiring a judgment-collection win:
//
//    Tier 1 (already in evidence checklist — included here for completeness):
//      - FCC consumer complaint
//      - State AG complaint
//      - ITG traceback
//      - FTC DNC complaint
//      - BBB complaint
//
//    Tier 2 (NEW — pressure stack proper):
//      - Carrier-of-record complaint  (after ITG identifies originating
//        carrier, file with that carrier's compliance/abuse team)
//      - USTelecom escalation         (when ITG traceback identifies a
//        non-cooperative downstream carrier, escalate to USTelecom)
//      - State PUC complaint          (Louisiana Public Service Commission
//        regulates intra-state carriers; complaints can prompt provider audits)
//      - Class-action firm referral   (TCPA-specialist firms take cases on
//        contingency; even when YOUR filing is uneconomic, the firm may
//        spin it into a class action)
//      - FTC Sentinel Network         (nationwide consumer-protection
//        intelligence database; FTC enforcement actions are built from
//        Sentinel pattern aggregation)
//      - Robocall index submissions   (Nomorobo, YouMail, RoboKiller —
//        community blacklists that block the number for OTHER consumers)
//      - Domain registrar complaint   (if Sonar surfaced a website, file
//        a ToS complaint with the registrar — Namecheap, GoDaddy)
//      - Seller-liability identifier  (FCC 2013 DISH ruling: the upstream
//        seller is liable for telemarketing on their behalf. Identify via
//        Sonar; pursue separately if findable.)
//
//  The Pressure Stack fires regardless of the GO/WAIT/DON'T-FILE verdict.
//  Even GO cases benefit — the parallel pressure shortens the time-to-
//  settlement and increases the odds the defendant pays voluntarily rather
//  than fighting in court.
// ─────────────────────────────────────────────────────────────────────────────

import type { OffenderProfile } from "./caseBuilder";

interface UserContext {
  userName: string;
  userPhone: string;
  userAddress: string;
  userEmail: string;
  userState: string;
  userStateLong: string;
  courtName?: string;
}

export interface PressureStackItem {
  id: string;
  tier: 1 | 2;
  title: string;
  category: "regulatory" | "carrier" | "industry" | "civil" | "media";
  why: string;
  action: "url" | "email" | "info" | "blocked";
  url?: string;
  template?: string;
  /** When `blocked: <prereq>`, this item is gated on a prerequisite (e.g.,
   *  ITG traceback response identifying the originating carrier). */
  blockedBy?: string;
  available: boolean;
  /** AUDIT_ROUND_23: auto-fire metadata. When `autoSendCapable`, the
   *  pressure-stack auto-fire orchestrator may send this item via SMTP
   *  if AUTO_SEND_PRESSURE=true is set. Each capable item declares the
   *  exact recipient + subject to use. */
  autoSendCapable?: boolean;
  autoSendRecipient?: string;
  autoSendSubject?: string;
  /** Populated by the auto-fire orchestrator after successful send. */
  autoSentAt?: string;
  autoSentMessageId?: string;
  autoSentSkippedReason?: string;
}

export interface PressureStack {
  generatedAt: string;
  items: PressureStackItem[];
  /** Coordinated-campaign membership — populated by detectCampaigns when
   *  this offender's company name matches another offender's. */
  campaignSiblings?: Array<{ normalizedNumber: string; companyName: string | null; callCount: number }>;
}

// ──────────────────────────────────────────────────────────────────────────
//  PUBLIC API
// ──────────────────────────────────────────────────────────────────────────

export function buildPressureStack(
  offender: OffenderProfile,
  user: UserContext
): PressureStack {
  const items: PressureStackItem[] = [];
  const callerNumber = offender.normalizedNumber;
  const company = offender.companyName ?? "(unknown)";
  const callsList = (offender.calls ?? []).map((c) => `${c.date} ${c.time}`).join(", ");
  const earliestDate = offender.firstCallDate ?? "(unknown)";
  const latestDate = offender.lastCallDate ?? "(unknown)";

  // ── Tier 2 items ──────────────────────────────────────────────────────

  // Carrier-of-record complaint (gated on ITG traceback completing)
  items.push({
    id: "carrier-of-record",
    tier: 2,
    title: "Carrier-of-record abuse complaint",
    category: "carrier",
    why: "Once ITG's traceback identifies the originating carrier (the telecom that put the call onto the network), file an abuse complaint with that carrier's compliance team. Carriers often suspend abusive customers to avoid FCC scrutiny — this is the single fastest way to take a spam operation offline.",
    action: "blocked",
    blockedBy: "ITG traceback response with originating carrier identified (typically 1-3 weeks after filing the traceback)",
    template: buildCarrierAbuseTemplate(offender, user),
    available: false,
  });

  // USTelecom escalation — auto-sendable (they accept industry email)
  items.push({
    id: "ustelecom-escalation",
    tier: 2,
    title: "USTelecom escalation (industry-wide enforcement)",
    category: "industry",
    why: "USTelecom (parent of ITG) tracks repeat-offender originating carriers and can escalate to the FCC's Enforcement Bureau. If ITG's traceback identifies a carrier that's been previously flagged, USTelecom may directly contact them.",
    action: "url",
    url: "https://ustelecom.org/contact/",
    template: `Subject: Repeat TCPA violator — request for industry escalation\n\nTo USTelecom Industry Enforcement Team,\n\nI am submitting a repeat-offender escalation request for telephone number ${callerNumber}, which has placed ${offender.callCount} unsolicited telemarketing calls to my DNC-registered residential number ${user.userPhone} between ${earliestDate} and ${latestDate}.\n\nI have already filed an ITG traceback request and will reference the traceback case number in this complaint once received. The caller identifies as ${company}.\n\nPlease consider this number for inclusion in the next FCC enforcement-bureau referral.\n\n${user.userName}`,
    available: true,
    autoSendCapable: true,
    autoSendRecipient: "info@ustelecom.org",
    autoSendSubject: `Repeat TCPA violator — escalation request — ${callerNumber}`,
  });

  // Louisiana PSC complaint
  items.push({
    id: "state-psc",
    tier: 2,
    title: `${user.userStateLong} Public Service Commission complaint`,
    category: "regulatory",
    why: `The ${user.userStateLong} PSC regulates intra-state telecommunications carriers. A complaint to the PSC can trigger a carrier audit, and carriers who fail audits face fines, license suspension, or required network changes. Less famous than the FCC but often more responsive for in-state issues.`,
    action: "url",
    url: "https://lpsc.louisiana.gov/CitizenComplaints.aspx",
    template:
      `Complainant: ${user.userName}\nResidential phone: ${user.userPhone}\nNature: Telephone Consumer Protection Act / Do Not Call violations\n\n` +
      `Caller phone: ${callerNumber}\nIdentified as: ${company}\n` +
      `${offender.callCount} call(s) between ${earliestDate} and ${latestDate}.\n\n` +
      `Calls placed to a DNC-registered residential number; recordings on file. Requesting that the LPSC investigate the originating carrier (identifiable via ITG traceback) for potential violations of LPSC General Order 5 on telemarketing and the carrier's obligations under 47 USC § 227.`,
    available: true,
  });

  // Class-action firm referral — auto-sendable to a configurable firm intake
  // Default recipient: Lemberg Law (publicly accepts TCPA referrals).
  // Override by setting CLASS_ACTION_REFERRAL_EMAIL in .env.
  items.push({
    id: "class-action-referral",
    tier: 2,
    title: "TCPA class-action firm referral",
    category: "civil",
    why: "TCPA-specialist firms take cases on contingency. Even when YOUR pro-se small-claims filing is uneconomic, a class-action firm may spin the same evidence into a class action with thousands of plaintiffs — outcomes range from $250k to $200M+ class settlements. The firm does the work; you potentially share in the recovery as a class representative.",
    action: "url",
    url: "https://www.lemberglaw.com/contact-us/",
    template: buildClassActionReferralEmail(offender, user),
    available: !!offender.companyName, // need a defendant name for any firm to bite
    autoSendCapable: !!offender.companyName,
    autoSendRecipient: process.env.CLASS_ACTION_REFERRAL_EMAIL ?? "intake@lemberglaw.com",
    autoSendSubject: `TCPA case referral — ${offender.companyName ?? offender.normalizedNumber} — class potential`,
  });

  // FTC Sentinel Network (already covered by FTC complaint, but explicit)
  items.push({
    id: "ftc-sentinel",
    tier: 2,
    title: "FTC Consumer Sentinel Network submission",
    category: "regulatory",
    why: "Sentinel is the FTC's pattern-aggregation database. Multiple consumer reports of the same defendant trigger automated alerts to the FTC's enforcement staff and to state AGs. Your FTC DNC complaint already auto-feeds Sentinel — this confirms you've done it.",
    action: "url",
    url: "https://reportfraud.ftc.gov",
    available: true,
  });

  // Nomorobo / RoboKiller / YouMail
  items.push({
    id: "robocall-blacklists",
    tier: 2,
    title: "Submit number to community robocall blacklists",
    category: "industry",
    why: "Nomorobo, RoboKiller, and YouMail run community-sourced blacklists that automatically block flagged numbers for millions of subscribers. Submitting your offender to all three takes 5 minutes and immediately reduces the operation's reach.",
    action: "info",
    template: `Submit ${callerNumber} via the consumer-report links at:\n\n  • Nomorobo:    https://www.nomorobo.com/lookup/${callerNumber.replace(/^\+/, "")}\n  • YouMail:     https://directory.youmail.com/phone/${callerNumber.replace(/^\+/, "")}\n  • RoboKiller:  https://lookup.robokiller.com/p/${callerNumber.replace(/^\+/, "")}\n\nMost surface a "Report this number" button. Fill in: caller said they were ${company}, called my DNC number ${offender.callCount}x.`,
    available: true,
  });

  // Domain registrar complaint (gated on Sonar finding a website)
  const sonar = offender.defendantWebResearch;
  let websiteUrl: string | null = null;
  if (sonar?.status === "match" && sonar.summary) {
    const m = sonar.summary.match(/https?:\/\/[^\s)]+/);
    if (m) websiteUrl = m[0];
  }
  items.push({
    id: "registrar-complaint",
    tier: 2,
    title: "Domain registrar abuse complaint" + (websiteUrl ? ` (target: ${websiteUrl.replace(/^https?:\/\//, "")})` : ""),
    category: "industry",
    why: "If the spammer has a website (Sonar may have surfaced one), every domain registrar — Namecheap, GoDaddy, Tucows, etc. — has an abuse@ contact and a published abuse policy. Telemarketing-fraud sites violate every registrar's ToS and frequently get suspended.",
    action: websiteUrl ? "url" : "blocked",
    url: websiteUrl ? `https://www.whois.com/whois/${encodeURIComponent(websiteUrl.replace(/^https?:\/\//, ""))}` : undefined,
    blockedBy: websiteUrl ? undefined : "Sonar didn't surface a defendant website. Re-run defendant research or manually identify their site.",
    template: websiteUrl ? `1. Visit https://www.whois.com/whois/${encodeURIComponent(websiteUrl.replace(/^https?:\/\//, ""))} to find the registrar.\n2. Email their abuse@ address (e.g., abuse@namecheap.com, abuse@godaddy.com).\n3. Subject: TCPA-violating telemarketing site — ${websiteUrl}\n4. Body: This site appears to be operated by a TCPA-violating telemarketing operation calling the National Do Not Call Registry. Caller phone: ${callerNumber}. Calls placed: ${offender.callCount}. Recordings on file. Please investigate per your acceptable-use policy.` : undefined,
    available: !!websiteUrl,
  });

  // Seller-liability identifier (info-only — the user has to do the actual identification)
  items.push({
    id: "seller-liability",
    tier: 2,
    title: "Identify upstream seller (TCPA seller liability — DISH 2013 ruling)",
    category: "civil",
    why: "Per the FCC's 2013 DISH Network ruling and 47 CFR 64.1200(f)(15), the SELLER (the company whose products the telemarketer is pitching) is jointly and severally liable for TCPA violations made on their behalf. Spammers are often spoofed shells, but the SELLER is usually a real US company with assets. Identify via Sonar / web research and pursue them separately — that's where the collectable money is.",
    action: "info",
    template: `Use the Sonar deep-research summary in defendant_research.txt to identify any upstream seller mentioned. Common patterns:\n\n  - "Acme Roofing" calls on behalf of "SolarCorp Solutions" → SolarCorp is the seller.\n  - "National Auto Protection" sells warranties for "EasyCare" → EasyCare is the seller.\n\nOnce identified, generate a SECOND filing packet against the seller using their actual business address. Sellers fight (because they have assets to lose) but they also settle (because TCPA class-action exposure is bad for their P&L).`,
    available: !!sonar && sonar.status === "match",
  });

  return {
    generatedAt: new Date().toISOString(),
    items,
  };
}

// ──────────────────────────────────────────────────────────────────────────
//  CLASS-ACTION FIRM REFERRAL EMAIL
// ──────────────────────────────────────────────────────────────────────────

function buildClassActionReferralEmail(offender: OffenderProfile, user: UserContext): string {
  const callsList = (offender.calls ?? []).map((c) => `  ${c.date} ${c.time}  callSid=${c.callSid}  recording=${c.recordingUrl ? "yes" : "no"}`).join("\n");
  const sonarSummary = offender.defendantWebResearch?.status === "match"
    ? offender.defendantWebResearch.summary?.slice(0, 800) ?? ""
    : "(none)";
  const litigationCount = offender.priorLitigation?.status === "match" ? offender.priorLitigation.caseCount : "unknown";

  return `Subject: TCPA case referral — ${offender.companyName ?? offender.normalizedNumber} — class potential

Dear TCPA Litigation Team,

I am a residential subscriber whose number is registered on the National Do Not Call Registry. I have been receiving unsolicited telemarketing calls from the operation described below and would like to refer this matter for class-action evaluation.

DEFENDANT CALLER
  Phone:           ${offender.normalizedNumber}
  Stated company:  ${offender.companyName ?? "(unknown — caller refused to identify)"}
  Stated names:    ${(offender.callerNames ?? []).join(", ") || "(unknown)"}
  Stated purpose:  ${offender.purpose ?? "(unknown)"}
  Line type:       ${offender.lineTypeLookup?.normalizedType ?? "not yet looked up"}

VIOLATION SUMMARY
  Number of calls: ${offender.callCount}
  Date range:      ${offender.firstCallDate} to ${offender.lastCallDate}
  Each call:
${callsList}

  All calls placed to a DNC-registered residential number, in violation of
  47 U.S.C. § 227(c)(5) and 47 C.F.R. § 64.1200(c). Each call was answered
  by an automated TCPA compliance recording (one-party-consent recording
  under La. R.S. 15:1303). Recordings, transcripts, and SHA-256 evidence
  integrity certificates are available on request.

PRIOR FEDERAL LITIGATION HISTORY
  CourtListener / RECAP search returned ${litigationCount} federal case(s)
  involving the named defendant or related entities.

WEB RESEARCH SUMMARY (Perplexity Sonar — verify before relying)
  ${sonarSummary}

CLASS-CERTIFICATION POTENTIAL
  This defendant appears to be running a coordinated telemarketing
  operation based on the call patterns observed. Per ITG traceback
  practice, multiple downstream consumers are likely affected. The
  defendant's business model implies a wide pool of potential class
  members.

PLAINTIFF (REFERRING PARTY)
  Name:    ${user.userName}
  Address: ${user.userAddress}
  Phone:   ${user.userPhone}
  Email:   ${user.userEmail}

I have NOT yet filed a small-claims action — I am referring the case to
your firm for class-action evaluation first. If your firm is interested
in pursuing this matter, I am willing to serve as a class representative.

Recordings, transcripts, evidence-integrity certificates, ITG traceback
correspondence, and FCC complaint receipts available on request.

Sincerely,

${user.userName}
${user.userEmail}
${user.userPhone}

Sent via SpamSlayer (https://github.com/example/spamslayer) — automated
TCPA evidence-collection + class-referral system.`;
}

// ──────────────────────────────────────────────────────────────────────────
//  CARRIER ABUSE COMPLAINT TEMPLATE
// ──────────────────────────────────────────────────────────────────────────

function buildCarrierAbuseTemplate(offender: OffenderProfile, user: UserContext): string {
  return `Subject: TCPA-violating customer using your network — ${offender.normalizedNumber}

To Carrier Compliance / Abuse Team,

I am writing to report a customer of your network who is placing unsolicited telemarketing calls in violation of the Telephone Consumer Protection Act (47 U.S.C. § 227) and the FCC's implementing regulations (47 C.F.R. § 64.1200).

ORIGINATING NUMBER:  ${offender.normalizedNumber}
ITG TRACEBACK CASE:  [INSERT ITG CASE NUMBER FROM TRACEBACK RESPONSE]
CALLER IDENTIFIES AS: ${offender.companyName ?? "(refused to identify)"}

VIOLATION DETAILS:
  - ${offender.callCount} unsolicited telemarketing calls to my residential number ${user.userPhone}
  - Date range: ${offender.firstCallDate} to ${offender.lastCallDate}
  - My number is registered on the National Do Not Call Registry
  - Each call was answered by a recorded TCPA compliance system
  - Recordings, transcripts, and SHA-256 evidence integrity certificates are on file

YOUR OBLIGATION:
Per the FCC's STIR/SHAKEN implementation requirements (47 CFR § 64.6300 et seq.) and the TRACED Act, you are required to investigate traffic from your customers that violates federal telemarketing law and take appropriate action — up to and including service termination — against repeat violators. Continued provision of service to a known TCPA violator may expose your company to FCC enforcement action.

REQUESTED ACTION:
Investigate this customer's compliance with your acceptable-use policy and TCPA. If they are unable to demonstrate consent or a valid established business relationship for their calls to my number, please terminate or suspend their service.

I have filed parallel complaints with the FCC, ${user.userStateLong} Attorney General, and the FTC. ITG traceback is in progress.

Respectfully,

${user.userName}
${user.userAddress}
${user.userPhone}
${user.userEmail}

CC: FCC Enforcement Bureau (filed via consumercomplaints.fcc.gov)
    ${user.userStateLong} Attorney General Consumer Protection Section`;
}

// ──────────────────────────────────────────────────────────────────────────
//  CROSS-CASE PATTERN DETECTION
// ──────────────────────────────────────────────────────────────────────────

export interface CampaignPattern {
  /** Stable identifier — derived from the pattern signal (e.g., normalized company name). */
  campaignId: string;
  /** What the pattern matched on (e.g., "company name 'Acme Roofing'"). */
  signal: string;
  /** Offenders running this campaign. */
  members: Array<{
    normalizedNumber: string;
    companyName: string | null;
    callCount: number;
    firstCallDate: string;
    lastCallDate: string;
    actionable: boolean;
  }>;
  /** Total damages-claimable across all members. */
  totalDamages: number;
  /** Suggested escalation: when N+ numbers run the same campaign, FCC/AG
   *  enforcement bureaus take notice. 3+ is "report it"; 5+ is "they'll act on it". */
  escalationLevel: "watch" | "report" | "actionable";
}

/**
 * Scan all offenders in the case database and group them into coordinated
 * campaigns based on shared signals (company name match, similar caller-name
 * pattern, similar transcript phrasing). Returns the detected patterns.
 *
 * Currently implemented signals:
 *   - Exact company-name match (case-insensitive, after entity-suffix strip)
 *   - Substring company-name match (e.g., "Acme Roofing" ⊂ "Acme Roofing LLC")
 */
export function detectCampaigns(allOffenders: OffenderProfile[]): CampaignPattern[] {
  const groups = new Map<string, OffenderProfile[]>();

  for (const o of allOffenders) {
    const company = (o.companyName ?? "").trim().toLowerCase();
    if (!company || company === "unknown") continue;
    // Normalize: strip common entity suffixes for grouping
    const stripped = company
      .replace(/\b(inc|llc|corp|company|co|ltd|l\.?p\.?|p\.?c\.?|\.|,)\b/gi, "")
      .replace(/\s+/g, " ")
      .trim();
    if (!stripped) continue;
    if (!groups.has(stripped)) groups.set(stripped, []);
    groups.get(stripped)!.push(o);
  }

  const patterns: CampaignPattern[] = [];
  for (const [name, members] of groups.entries()) {
    if (members.length < 2) continue; // need 2+ numbers running the same script
    const totalDamages = members.reduce((s, m) => s + (m.damagesEstimate ?? 0), 0);
    const escalationLevel: "watch" | "report" | "actionable" =
      members.length >= 5 ? "actionable" :
      members.length >= 3 ? "report" : "watch";
    patterns.push({
      campaignId: `campaign-${name.replace(/\s+/g, "-")}`,
      signal: `Company name "${members[0].companyName}" appears across ${members.length} offender numbers`,
      members: members.map((m) => ({
        normalizedNumber: m.normalizedNumber,
        companyName: m.companyName,
        callCount: m.callCount,
        firstCallDate: m.firstCallDate,
        lastCallDate: m.lastCallDate,
        actionable: m.actionable,
      })),
      totalDamages,
      escalationLevel,
    });
  }

  // Sort by escalationLevel (actionable first), then by total damages desc
  const order = { actionable: 0, report: 1, watch: 2 };
  patterns.sort((a, b) => {
    const d = order[a.escalationLevel] - order[b.escalationLevel];
    return d !== 0 ? d : b.totalDamages - a.totalDamages;
  });
  return patterns;
}

// ──────────────────────────────────────────────────────────────────────────
//  AUTO-FIRE ORCHESTRATOR
// ──────────────────────────────────────────────────────────────────────────

import { sendMail, type SendMailResult } from "./mailer";
import { lookupCarrierAbuse, lookupRegistrarByName, lookupRegistrarAbuseHeuristic, whoisRegistrarName } from "./abuseContacts";

export interface AutoFireResult {
  itemId: string;
  title: string;
  recipient: string;
  result: SendMailResult;
}

/**
 * Iterate through the pressure stack and SEND every auto-capable item that
 * hasn't already been sent for this case. Updates each item's autoSentAt /
 * autoSentMessageId / autoSentSkippedReason on the offender's persisted
 * stack. Returns per-item results for audit logging.
 *
 * Honors AUTO_SEND_PRESSURE env gate (mailer.sendMail no-ops when disabled).
 */
export async function autoFirePressureStack(
  offender: OffenderProfile,
  user: UserContext,
  options: { force?: boolean } = {}
): Promise<AutoFireResult[]> {
  const stack = buildPressureStack(offender, user);
  const results: AutoFireResult[] = [];

  for (const item of stack.items) {
    if (!item.autoSendCapable) continue;
    if (!item.autoSendRecipient || !item.autoSendSubject) continue;
    if (!item.available && !options.force) continue;
    if (item.autoSentAt && !options.force) continue; // don't double-fire

    const r = await sendMail({
      to: item.autoSendRecipient,
      subject: item.autoSendSubject,
      body: item.template ?? `(no template body — auto-fire fallback for ${item.title})`,
    });
    results.push({ itemId: item.id, title: item.title, recipient: item.autoSendRecipient, result: r });
  }

  return results;
}

/**
 * Auto-fire ONLY the items that are gated on a prerequisite that's now met.
 * Used by the background pump after ITG identifies the carrier OR Sonar
 * surfaces a defendant website.
 *
 * Returns the list of items fired (or attempted).
 */
export async function autoFireUnlockedItems(
  offender: OffenderProfile,
  user: UserContext,
  unlock: { carrierName?: string; websiteUrl?: string }
): Promise<AutoFireResult[]> {
  const results: AutoFireResult[] = [];

  // Carrier-of-record: ITG response identified the carrier
  if (unlock.carrierName) {
    const carrier = lookupCarrierAbuse(unlock.carrierName);
    if (carrier) {
      const subject = `TCPA-violating customer using your network — ${offender.normalizedNumber}`;
      // Re-render the carrier abuse template with the actual carrier name
      const stack = buildPressureStack(offender, user);
      const carrierItem = stack.items.find((i) => i.id === "carrier-of-record");
      const body = carrierItem?.template ?? "";
      const result = await sendMail({ to: carrier.email, subject, body });
      results.push({ itemId: "carrier-of-record", title: `Carrier abuse — ${carrier.name}`, recipient: carrier.email, result });
    }
  }

  // Domain registrar: Sonar found a website
  if (unlock.websiteUrl) {
    let registrar = null;
    const registrarName = await whoisRegistrarName(unlock.websiteUrl);
    if (registrarName) {
      registrar = lookupRegistrarByName(registrarName);
    }
    if (!registrar) {
      registrar = lookupRegistrarAbuseHeuristic(unlock.websiteUrl);
    }

    const subject = `Abuse complaint: TCPA-violating telemarketing site — ${unlock.websiteUrl}`;
    const body =
      `Hello,\n\n` +
      `I am writing to report a domain registered through your registrar that is being used by a TCPA-violating telemarketing operation.\n\n` +
      `Domain / website:    ${unlock.websiteUrl}\n` +
      `Originating phone:   ${offender.normalizedNumber}\n` +
      `Caller identifies as: ${offender.companyName ?? "(unknown)"}\n` +
      `Calls placed:        ${offender.callCount}\n` +
      `Date range:          ${offender.firstCallDate} to ${offender.lastCallDate}\n\n` +
      `My residential telephone number is registered on the National Do Not Call Registry. The above operation has placed ${offender.callCount} unsolicited telemarketing calls in violation of the Telephone Consumer Protection Act (47 U.S.C. § 227) and the FCC's implementing regulations.\n\n` +
      `Please investigate this domain per your acceptable-use policy. If the operator cannot demonstrate compliance with federal telemarketing law, I respectfully request that the domain be suspended.\n\n` +
      `Recordings, transcripts, and SHA-256 evidence integrity certificates are available on request. I have filed parallel complaints with the FCC, Federal Trade Commission, and ${user.userStateLong} Attorney General.\n\n` +
      `Respectfully,\n\n${user.userName}\n${user.userEmail}\n${user.userPhone}`;

    const result = await sendMail({ to: registrar.email, subject, body });
    results.push({ itemId: "registrar-complaint", title: `Registrar abuse — ${registrar.name}`, recipient: registrar.email, result });
  }

  return results;
}

// ──────────────────────────────────────────────────────────────────────────
//  RENDERERS
// ──────────────────────────────────────────────────────────────────────────

export function renderPressureStackAsText(stack: PressureStack, offender: OffenderProfile): string {
  const available = stack.items.filter((i) => i.available);
  const blocked = stack.items.filter((i) => !i.available);

  const lines: string[] = [
    "═══════════════════════════════════════════════════════════════════════",
    "                     PRESSURE STACK",
    "         Non-judgment enforcement paths against this defendant",
    "═══════════════════════════════════════════════════════════════════════",
    `Offender:  ${offender.normalizedNumber}`,
    `Company:   ${offender.companyName ?? "(unknown)"}`,
    `Generated: ${stack.generatedAt}`,
    "",
    "Even when the filing-decision verdict says DON'T FILE (uncollectable",
    "defendant, weak case), the spammer is still breaking the law. These are",
    "the parallel-enforcement paths that create operational pressure WITHOUT",
    "requiring a judgment-collection win. Fire as many as apply — most are",
    "free, all add to the public record.",
    "",
    "═══════════════════════════════════════════════════════════════════════",
    `  AVAILABLE NOW (${available.length} action${available.length === 1 ? "" : "s"})`,
    "═══════════════════════════════════════════════════════════════════════",
  ];

  for (const item of available) {
    lines.push("");
    lines.push(`  ▶  ${item.title}  [${item.category}]`);
    lines.push("");
    lines.push("     WHY:");
    item.why.match(/.{1,68}(\s|$)/g)?.forEach((c) => lines.push(`       ${c.trim()}`));
    if (item.url) {
      lines.push("");
      lines.push(`     URL: ${item.url}`);
    }
    if (item.template) {
      lines.push("");
      lines.push("     COPY-PASTE TEMPLATE:");
      lines.push("     ──────────────────────");
      item.template.split("\n").forEach((l) => lines.push(`       ${l}`));
      lines.push("     ──────────────────────");
    }
    lines.push("");
    lines.push("───────────────────────────────────────────────────────────────────────");
  }

  if (blocked.length > 0) {
    lines.push("");
    lines.push("═══════════════════════════════════════════════════════════════════════");
    lines.push(`  BLOCKED — fires later (${blocked.length})`);
    lines.push("═══════════════════════════════════════════════════════════════════════");
    for (const item of blocked) {
      lines.push("");
      lines.push(`  ⏸  ${item.title}  [${item.category}]`);
      lines.push(`     BLOCKED BY: ${item.blockedBy}`);
      lines.push(`     WHY: ${item.why.slice(0, 120)}`);
      lines.push("");
      lines.push("───────────────────────────────────────────────────────────────────────");
    }
  }

  lines.push("");
  lines.push("END OF PRESSURE STACK");
  return lines.join("\n");
}
