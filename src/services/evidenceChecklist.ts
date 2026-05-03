// ─────────────────────────────────────────────────────────────────────────────
//  evidenceChecklist.ts — per-case evidence-gathering checklist + stage prep
//
//  When a case becomes actionable, Marcus needs to do several manual things
//  to strengthen the evidence stack BEFORE filing. None of these have public
//  consumer APIs — but every one can be PRE-FILLED, with realistic prep so
//  he knows exactly what he's walking into.
//
//  DESIGN PRINCIPLE (per Marcus 2026-05-03):
//    • Every action defaults to the EASY/FREE path (portal screenshots,
//      web forms with copy-paste-ready bodies).
//    • Hard / expensive escalations (subpoenas, court paperwork) are tucked
//      under each item's `escalation` block and surfaced ONLY when the
//      easy path fails or when the case actually contests.
//    • Each item has a `whatToExpect` walkthrough — what you'll see when
//      you click the link, how long it takes, what they'll ask for, what
//      can go wrong.
//
//  In addition to the per-item checklist, this module also generates a
//  CASE_STAGES_GUIDE.txt that walks through the bigger-picture roadmap
//  (demand letter → file → default vs. contested → judgment → collect)
//  so Marcus knows what's coming before it gets there.
// ─────────────────────────────────────────────────────────────────────────────

import type { OffenderProfile } from "./caseBuilder";

interface ChecklistItem {
  id: string;
  title: string;
  why: string;
  action: "url" | "copy" | "email" | "info";
  url?: string;
  template?: string;
  mailto?: string;
  whatToExpect?: string;
  escalation?: {
    trigger: string;
    title: string;
    instructions: string;
    url?: string;
    template?: string;
  };
  completed: boolean;
  completedAt?: string | null;
}

interface UserContext {
  userName: string;
  userPhone: string;        // E.164, e.g. "+13375550100"
  userAddress: string;
  userEmail: string;
  userState: string;        // USPS code, e.g. "LA"
  userStateLong: string;    // e.g. "Louisiana"
  courtName?: string;       // e.g. "Lafayette City Court"
}

// ──────────────────────────────────────────────────────────────────────────
//  PER-ITEM CHECKLIST GENERATOR
// ──────────────────────────────────────────────────────────────────────────

export function buildEvidenceChecklist(
  offender: OffenderProfile,
  user: UserContext
): NonNullable<OffenderProfile["evidenceChecklist"]> {
  const callerNumber = offender.normalizedNumber;
  const callsList = (offender.calls ?? []).map((c) => `${c.date} ${c.time}`).join(", ");
  const earliestDate = offender.firstCallDate ?? "(unknown)";
  const latestDate = offender.lastCallDate ?? "(unknown)";

  const itgBody =
    `Originating call number: ${callerNumber}\n` +
    `Called number (recipient): ${user.userPhone}\n` +
    `Number of calls: ${offender.callCount}\n` +
    `Date range: ${earliestDate} to ${latestDate}\n` +
    `All call timestamps: ${callsList}\n` +
    `Recipient's status on DNC Registry: registered\n` +
    `Caller's stated company: ${offender.companyName ?? "unknown / not captured"}\n` +
    `Caller's stated name: ${(offender.callerNames ?? []).join(", ") || "unknown / not captured"}\n` +
    `Stated purpose: ${offender.purpose ?? "unknown / not captured"}\n\n` +
    `These calls were answered by an automated TCPA compliance recording on a residential telephone number registered with the National Do Not Call Registry. Each call was recorded under one-party consent. Recording URLs and transcripts are available on request.`;

  const items: ChecklistItem[] = [
    // ── 1. ITG TRACEBACK (~5 min, web form, free) ──────────────────────
    {
      id: "itg",
      title: "File ITG traceback request",
      why: "ITG (Industry Traceback Group, FCC-designated U.S. Traceback Consortium) traces the call back through the carrier chain to its origin carrier. Their report is a quasi-governmental third-party record that's been admitted in TCPA cases. File within ~5 days of the most recent call for best traceback success — older calls have a much lower trace-completion rate.",
      action: "url",
      url: "https://tracebacks.org/traceback-requests/",
      template: itgBody,
      whatToExpect:
        "WHAT YOU'LL SEE: a single-page web form titled 'Traceback Request'. Fields: your name, your email, the originating phone number, the called number, the date(s) and time(s), and a description box.\n\n" +
        "WHAT TO DO: paste the template above into the description field — it's pre-formatted with everything ITG asks for. Use your real name and email. Submit.\n\n" +
        "HOW LONG: ~3 min to fill out, no account needed.\n\n" +
        "WHAT HAPPENS NEXT: ITG emails an acknowledgment within 24 hours with a tracking number. Save that email. They'll work the traceback through participating carriers (~1-3 weeks). If successful, you'll get a follow-up email naming the originating carrier. If unsuccessful (call too old, or unparticipating carrier in the chain), they'll tell you so — that itself is useful evidence.\n\n" +
        "WHAT TO WATCH FOR: don't include profanity or threats in the description — ITG will reject the request. Also don't claim damages amounts here; that's for the petition, not the traceback request.",
      completed: false,
    },

    // ── 2. AT&T USAGE DETAIL (5 min, portal, free) ─────────────────────
    {
      id: "att-cdr",
      title: "Screenshot AT&T usage detail for the call dates",
      why: "Your carrier's call records are independent third-party evidence that the spam call hit the network at the timestamps you claim. Defense can't credibly dispute what AT&T's billing system recorded. As the account holder, you can authenticate a portal screenshot yourself in court under FRE 901(b)(1).",
      action: "url",
      url: "https://www.att.com/my/#/profile/usage",
      whatToExpect:
        "WHAT YOU'LL SEE: after logging in, click 'My Account' → 'Usage' → 'View Past Usage'. Pick the billing cycle that contains the call date(s). The page lists every inbound and outbound call with date, time, duration, and the calling number.\n\n" +
        "WHAT TO DO:\n" +
        "  1. Filter or scroll to the row(s) showing calls from " + callerNumber + ".\n" +
        "  2. Take a full-page screenshot showing the carrier's URL bar, the offending row(s) highlighted, and the date filter visible (so the screenshot is self-authenticating).\n" +
        "  3. ALSO click the 'Download as PDF/CSV' button — AT&T offers both. Save as 'Exhibit_C_ATT_Usage_Detail_" + (offender.firstCallDate ?? "DATE") + ".pdf'.\n" +
        "  4. Drop the file in your case folder; reference it as Exhibit C in the petition.\n\n" +
        "HOW LONG: ~5 minutes if you're already logged in, ~10 min if you have to do MFA.\n\n" +
        "WHAT TO WATCH FOR: AT&T's portal sometimes only shows the last 6 billing cycles. If your call is older, you'll need to use the escalation path below.",
      escalation: {
        trigger: "Use this ONLY if: (a) the call is older than 6 months and not in the portal, OR (b) the defendant actually shows up in court and contests that the calls happened. For the typical default-judgment case, the portal screenshot is enough.",
        title: "Subpoena AT&T for certified Call Detail Records",
        instructions:
          "Cost: ~$15 (clerk's filing fee + service). Time: ~1 hour at the clerk's office. Response time from AT&T: 30-90 days.\n\n" +
          "Step-by-step:\n" +
          "  1. File your small-claims petition first to get a docket number.\n" +
          "  2. Walk to the " + (user.courtName ?? "Lafayette City Court") + " clerk's office. Ask for a 'subpoena duces tecum' form for AT&T (or a generic third-party records subpoena).\n" +
          "  3. Fill in: case number, defendant name, the records you want (described in the template below), the date range, and where to serve AT&T (their registered agent for service in Louisiana is CT Corporation System, 3867 Plaza Tower Dr., Baton Rouge, LA 70816).\n" +
          "  4. Clerk seals + signs. Pay ~$5-10 issuance fee.\n" +
          "  5. Serve via certified mail to AT&T's CT Corporation registered agent. Or pay a process server (~$30) for faster service.\n" +
          "  6. Save the certified-mail green card as proof of service.\n\n" +
          "AT&T Legal Compliance will respond with a Rule 902(11) certification + the records, OR a written objection (rare for routine CDR subpoenas).",
        template: buildCarrierSubpoena("AT&T", offender, user),
      },
      completed: false,
    },

    // ── 3. RED POCKET USAGE DETAIL (5 min, portal, free) ───────────────
    {
      id: "redpocket-cdr",
      title: "Screenshot Red Pocket usage detail (if Red Pocket is the line)",
      why: "If the spammed line is on Red Pocket, pull their usage detail too. Red Pocket is an MVNO that resells AT&T/Verizon/T-Mobile capacity, so the underlying network record may also be reachable via the host carrier — but for routine evidence, the Red Pocket portal screenshot is sufficient.",
      action: "url",
      url: "https://www.redpocket.com/account/login",
      whatToExpect:
        "WHAT YOU'LL SEE: after logging in, navigate to 'My Account' → 'Usage History' or 'Call Logs'. The Red Pocket portal is more limited than AT&T's — it usually only shows the current and previous billing cycle. Format varies depending on which underlying network (GSMA / GSMT / CDMA) your line uses.\n\n" +
        "WHAT TO DO:\n" +
        "  1. Filter to the date range that contains the spam calls.\n" +
        "  2. Screenshot the call log page, including the URL bar and your account number visible.\n" +
        "  3. If Red Pocket offers PDF/CSV export, use it. If not, the screenshot alone is fine — you can authenticate as the account holder.\n" +
        "  4. Save as 'Exhibit_C2_RedPocket_Usage_Detail_" + (offender.firstCallDate ?? "DATE") + '.png/.pdf' + "'.\n\n" +
        "HOW LONG: ~5 min.\n\n" +
        "SKIP THIS ITEM IF: the spammed line isn't on Red Pocket (i.e., this is your AT&T-only number). Just check the box and move on.",
      escalation: {
        trigger: "Use this ONLY if: defendant contests the calls AND Red Pocket's portal data is too sparse for court. Subpoenas to MVNOs sometimes get redirected to the host carrier (AT&T/Verizon/T-Mobile) — be prepared for that.",
        title: "Subpoena Red Pocket Mobile for certified Call Detail Records",
        instructions:
          "Same general process as the AT&T subpoena above. Red Pocket's registered agent for service of process: look up at https://opencorporates.com or your state's SoS database. Their corporate parent is Red Pocket Mobile / RPM Group based in Los Angeles, CA — service may need to go to California.\n\n" +
          "If Red Pocket says 'records held by host carrier', re-issue the subpoena to the host carrier identified in their response.",
        template: buildCarrierSubpoena("Red Pocket Mobile", offender, user),
      },
      completed: false,
    },

    // ── 4. FCC COMPLAINT (5 min, web form, free) ───────────────────────
    {
      id: "fcc",
      title: "File FCC consumer complaint (form 1088)",
      why: "Parallel enforcement pressure. The FCC complaint generates a docket number that goes into the Robocall Mitigation Database — both a third-party record AND a signal to the defendant's carrier that the calls are flagged. Doesn't compete with your civil suit; it complements it.",
      action: "url",
      url: "https://consumercomplaints.fcc.gov/hc/en-us/requests/new",
      template:
        "Use these exact field values in the FCC form:\n\n" +
        "  Type of complaint:        Unwanted calls (telemarketing/robocalls)\n" +
        "  Phone number that was called: " + user.userPhone + "\n" +
        "  Caller phone number:      " + callerNumber + "\n" +
        "  Caller name (if known):   " + (offender.companyName ?? "Unknown / spoofed caller ID") + "\n" +
        "  Date(s) of call(s):       " + callsList + "\n" +
        "  On DNC Registry:          Yes\n" +
        "  Description: I received " + offender.callCount + " unsolicited telemarketing calls from " + callerNumber + " between " + earliestDate + " and " + latestDate + ". My number is registered on the National Do Not Call Registry. Each call was recorded under one-party consent (La. R.S. 15:1303); audio and transcripts are available on request. The calls violated 47 U.S.C. § 227(c) and 47 C.F.R. § 64.1200.",
      whatToExpect:
        "WHAT YOU'LL SEE: the FCC's Zendesk-styled complaint portal. You'll create a free account (or log in via Google) before submitting. The form is split into 'About you', 'About the call', and 'Description'.\n\n" +
        "WHAT TO DO: paste the field values above into the matching form fields. The Description field accepts ~2000 characters — you have room to mention recordings exist.\n\n" +
        "HOW LONG: ~5 min including account creation.\n\n" +
        "WHAT HAPPENS NEXT: FCC sends a confirmation email with a complaint number (format: 25NNNNNN). Save that email — the complaint number is your third-party docket reference. The complaint goes into the FCC's public Robocall Mitigation Database; some defendants' carriers (Twilio, Bandwidth, etc.) actively monitor that DB and may suspend the offender's outbound calling.\n\n" +
        "WHAT NOT TO DO: don't claim a specific damages amount in the FCC form. The FCC doesn't award damages; that's for your civil suit. Stating amounts here can box you in later.",
      completed: false,
    },

    // ── 5. STATE AG COMPLAINT (10 min, web form, free) ─────────────────
    {
      id: "state-ag",
      title: `File ${user.userStateLong} AG consumer protection complaint`,
      why: `${user.userStateLong}'s Attorney General accepts TCPA / unwanted-call complaints through their Consumer Protection Section. Adds another enforcement vector AND another third-party docket reference for your evidence file. State AGs occasionally aggregate consumer complaints into class actions — having a docket number on file means you'd be included.`,
      action: "url",
      url: "https://www.ag.state.la.us/Complaints",
      template:
        "Complainant: " + user.userName + "\n" +
        "Phone called: " + user.userPhone + "\n" +
        "Caller phone: " + callerNumber + "\n" +
        "Caller company: " + (offender.companyName ?? "Unknown") + "\n" +
        "Date(s): " + callsList + "\n\n" +
        "Brief: I received " + offender.callCount + " unsolicited telemarketing call(s) from " + callerNumber + " between " + earliestDate + " and " + latestDate + ". My number is registered on the National Do Not Call Registry. The caller(s) violated 47 U.S.C. § 227 and the FCC's implementing regulations at 47 C.F.R. § 64.1200. I respectfully request that the " + user.userStateLong + " Attorney General investigate and pursue any appropriate enforcement action.",
      whatToExpect:
        "WHAT YOU'LL SEE: the Louisiana AG's complaint intake page (or your state's equivalent). Most state AG portals are clunky — expect a multi-step form with fields for your address, the defendant's address (use 'Unknown — spoofed' if you don't have it), and a description.\n\n" +
        "WHAT TO DO: paste the brief above. If they ask for an 'amount in dispute', enter your estimated TCPA statutory damages ($" + (offender.damagesEstimate ?? 500) + " for this case). If they ask whether you've filed in court yet, say 'considering' if you haven't filed, 'yes' if you have.\n\n" +
        "HOW LONG: ~10 min.\n\n" +
        "WHAT HAPPENS NEXT: AG's office sends a written confirmation (sometimes by mail, sometimes email) with a complaint number. They may forward your complaint to the defendant for response — that response (or silence) becomes more evidence. Most state AGs don't take individual TCPA cases to court but they DO track patterns; multiple complaints against the same defendant can trigger an investigation.\n\n" +
        "WHAT TO WATCH FOR: some state AG portals require you to upload supporting documents. If asked, attach the AT&T usage screenshot you grabbed in step 2.",
      completed: false,
    },

    // ── 6. CALENDAR REMINDER (1 min, free) ─────────────────────────────
    {
      id: "calendar-reminder",
      title: "Set 14-day calendar reminder to follow up on ITG + carrier records",
      why: "ITG tracebacks come back in 1-3 weeks. FCC and state-AG acknowledgments arrive within ~5 business days. Without a reminder these often slip and you forget to attach them to the petition.",
      action: "url",
      url: buildGoogleCalendarUrl(offender, user),
      whatToExpect:
        "WHAT YOU'LL SEE: clicking the link above opens Google Calendar's event-creation page with the title, date (14 days out), and description pre-filled. If you use Apple Calendar or Outlook, the link won't work — set a manual reminder titled 'SpamSlayer follow-up: " + (offender.companyName ?? offender.normalizedNumber) + "' for 14 days from today.\n\n" +
        "WHAT TO DO: just click 'Save' once Google Calendar opens. Done.\n\n" +
        "HOW LONG: 30 seconds.",
      completed: false,
    },

    // ── 7. DEMAND LETTER (10 min + cert mail trip) ─────────────────────
    {
      id: "demand-letter",
      title: "Send demand letter via certified mail (return receipt requested)",
      why: "The demand letter starts the 30-day clock and converts post-demand calls into willful/treble damages ($1,500 per call instead of $500). Even if the defendant ignores it, you've created a legal record that puts them on notice — that record itself becomes Exhibit B in your petition.",
      action: "info",
      template:
        "The demand letter is auto-generated. Pull it via:\n\n" +
        "  curl -X POST http://localhost:3003/api/cases/demand-letter \\\n" +
        "    -H 'Content-Type: application/json' \\\n" +
        "    -d '{\"number\":\"" + callerNumber + "\",\"userName\":\"" + user.userName + "\",\"userAddress\":\"" + user.userAddress + "\",\"userPhone\":\"" + user.userPhone + "\",\"dncSince\":\"YYYY-MM-DD\"}'\n\n" +
        "Or pull it from the dashboard if you've added a UI button.",
      whatToExpect:
        "WHAT YOU'LL DO:\n" +
        "  1. Generate the demand letter (the API call above produces a fully-formatted certified-mail-ready letter).\n" +
        "  2. Print it. Sign + date the bottom.\n" +
        "  3. Walk to USPS. Buy a Certified Mail label (~$4.85) AND a Return Receipt — the GREEN CARD (~$3.65). Total ~$8.50.\n" +
        "  4. Mail to the defendant's address. If you don't have an address, mail to their registered agent (use the OpenCorporates or state SoS lookup; for spoofed-caller-ID cases this might not be possible).\n" +
        "  5. When the green card comes back ~2 weeks later, scan it. That's Exhibit B.\n\n" +
        "WHAT YOU'RE WAITING FOR: 30 days from delivery date (per the green card). Calls that arrive AFTER that date are 'willful' under § 227(c)(5), trebling damages. Track those calls — they're worth $1500 each instead of $500.\n\n" +
        "WHAT NOT TO DO: don't email the demand letter — the legal weight of certified mail is its delivery proof, which only certified-mail green cards provide. Email is too easy to deny receipt. Don't threaten criminal prosecution in the demand letter — TCPA is purely civil.",
      completed: false,
    },
  ];

  return {
    generatedAt: new Date().toISOString(),
    lastReminderAt: null,
    items,
  };
}

// ──────────────────────────────────────────────────────────────────────────
//  CASE STAGES GUIDE — the bigger-picture roadmap
// ──────────────────────────────────────────────────────────────────────────

/**
 * Generate a printable "what to expect at each stage of a TCPA small-claims
 * case" document. Lives in the saved filing package as CASE_STAGES_GUIDE.txt
 * so Marcus has the roadmap before he files.
 */
export function buildCaseStagesGuide(
  offender: OffenderProfile,
  user: UserContext
): string {
  const court = user.courtName ?? "Lafayette City Court";
  const callerNumber = offender.normalizedNumber;
  const damages = offender.damagesEstimate ?? 0;

  return `═══════════════════════════════════════════════════════════════════════
                  TCPA CASE — STAGES GUIDE
              What to expect at each step of the road
═══════════════════════════════════════════════════════════════════════
Case:              ${offender.companyName ?? "(unknown defendant)"} (${callerNumber})
Damages claimed:   $${damages.toLocaleString()}
Court:             ${court}
Generated:         ${new Date().toISOString()}

This document walks you through the realistic timeline of a TCPA small-
claims case from spam call to (hopefully) collected judgment. Read it
before you file so nothing surprises you.

The honest baseline: roughly 40-55% of pro-se TCPA small-claims filings
either survive the motion to dismiss or get a default judgment. Roughly
5-10% actually collect any money. The bottleneck isn't winning — it's
collecting from a defendant that's often a spoofed-VoIP shell.

═══════════════════════════════════════════════════════════════════════
  STAGE 1 — EVIDENCE GATHERING (you are here, days 0-30)
═══════════════════════════════════════════════════════════════════════

WHAT'S HAPPENING:
SpamSlayer has logged enough calls to make this case actionable (>= 2
calls in 12 months, per § 227(c)(5)). The bot has captured recordings,
transcripts, and metadata. Now you need to ADD third-party corroborating
evidence so the case isn't just "Marcus says these calls happened."

WHAT TO DO:
Work the EVIDENCE_CHECKLIST.txt that's in this folder. Top-to-bottom.
The checklist is ordered by leverage — ITG traceback first (free, ~5min,
strongest external evidence), then carrier portal screenshots, then
parallel-enforcement complaints (FCC + state AG).

WHAT YOU'RE UP AGAINST:
- Time: spam-call evidence has a half-life. ITG traceback success drops
  sharply after the call is older than ~14 days.
- Spoofing: the caller ID may not belong to the actual caller. Your
  Sonar research and ITG traceback will tell you if the number is
  spoofed and if so, who actually made the call.
- The defendant might already be dissolved, shell, or offshore. The
  collectability score in defendant_research.txt is your honest read.

WHAT TO DECIDE AT THIS STAGE:
After you've gathered evidence and read the defendant research, you have
a fork in the road:
  (a) Strong evidence + collectible defendant → proceed to Stage 2.
  (b) Weak evidence OR uncollectable defendant → DON'T file the petition.
      Instead, double down on parallel-enforcement complaints (FCC, state
      AG, FTC, BBB, ITG). The defendant's carrier may suspend their
      service even without a court judgment.

═══════════════════════════════════════════════════════════════════════
  STAGE 2 — DEMAND LETTER (days 7-37)
═══════════════════════════════════════════════════════════════════════

WHAT'S HAPPENING:
You send a formal demand letter via certified mail. This puts the
defendant on notice and starts the 30-day clock. Calls that come AFTER
the letter is delivered are "willful" under § 227(c)(5)(A) — damages
treble from $500 to $1,500 per call.

WHAT TO DO:
1. Generate the letter (POST /api/cases/demand-letter).
2. Print, sign, mail Certified Mail with Return Receipt Requested
   (~$8.50 at USPS).
3. Send to the defendant's registered agent address (lookup via state
   SoS or OpenCorporates). If the defendant is unknown / spoofed, skip
   to Stage 3 — without an address, you can't formally demand.
4. When the green card returns (~2 weeks), file it. That's Exhibit B.
5. Wait 30 days. During that time, track any new calls — those are now
   willful and worth 3x damages.

WHAT YOU'RE UP AGAINST:
- Defendant might respond with a settlement offer. That's actually a
  good outcome — typical pro-se TCPA settlements range from $250 to
  $2,500 depending on call count and clarity of evidence. If they offer,
  evaluate against the cost of going to court.
- Defendant might respond with a denial or counter-claim ("we have proof
  of your consent"). Read carefully — they'll usually point to a TOS
  click on a website. If you ever filled out a form on a related site,
  consult an attorney before pushing further.
- Most defendants ignore the letter entirely. That's also fine — silence
  is what triggers proceeding to filing.

═══════════════════════════════════════════════════════════════════════
  STAGE 3 — FILING THE PETITION (days 30-45)
═══════════════════════════════════════════════════════════════════════

WHAT'S HAPPENING:
You walk into the ${court} clerk's office with the petition packet
this system generated. You pay the filing fee, the clerk stamps + dockets
your case, and you walk out with a case number.

WHAT TO DO:
1. Print the entire filing package — petition, exhibit list, certificate
   of service, filing guide, plus all your collected exhibits (Twilio
   recordings on a USB stick or printed transcripts, AT&T usage screen-
   shots, ITG traceback letter, FCC complaint receipt, demand letter +
   green card). Make 3 sets: court copy, defendant copy, your copy.
2. Sign the petition's verification block. Read it carefully — you're
   swearing under penalty of perjury that the facts are true.
3. Walk to the clerk. Pay filing fee (~$75 in Lafayette City Court).
4. The clerk gives you a case number, a stamped copy, and instructions
   for serving the defendant.

WHAT YOU'RE UP AGAINST:
- The clerk may push back on a TCPA case ("are you sure you're in the
  right court?"). Lafayette City Court has subject-matter jurisdiction
  over civil claims up to $50,000 (La. C.C.P. Art. 4843) including
  TCPA. You're in the right place.
- The judge may not be familiar with TCPA. Your filing guide has a
  one-page "court briefing" you can hand the clerk to forward to the
  judge. Don't be defensive about being pro se — small-claims judges
  see pro se filers every day.
- Federal removal: if your damages claim exceeds the federal jurisdiction
  threshold OR the defendant is a national company, they MAY remove the
  case to federal court. The filing guide explains how to handle that
  (you can usually move to remand back to state court).

═══════════════════════════════════════════════════════════════════════
  STAGE 4 — SERVICE OF PROCESS (days 45-60)
═══════════════════════════════════════════════════════════════════════

WHAT'S HAPPENING:
The defendant has to be formally notified that you've sued them. This
is service of process. In Louisiana small claims, service is usually
performed by the sheriff or a process server, NOT by you personally.

WHAT TO DO:
1. The clerk will tell you whether the court issues service automatically
   or whether you need to arrange it. In Lafayette City Court, the
   sheriff's office handles service for a fee (~$30-50).
2. Provide the defendant's address — registered agent for service for
   corporate defendants. State SoS database has this (free).
3. Wait for the proof-of-service return. Without proof of service, the
   case can't proceed.

WHAT YOU'RE UP AGAINST:
- Spoofed-caller-ID defendants are often unservable. If the registered
  agent doesn't exist, no one to serve. The case stalls. This is the
  single biggest reason TCPA small-claims cases die.
- Defendants who CAN be served sometimes refuse to accept. The sheriff
  re-attempts; eventually the court can authorize service by publication
  (in a newspaper) or by mail to the registered agent.
- Defendants located out of state require long-arm service — the petition
  invokes La. R.S. 13:3201; check the filing guide for the long-arm
  procedure if your defendant is out of state.

═══════════════════════════════════════════════════════════════════════
  STAGE 5 — DEFENDANT RESPONSE (days 60-90)
═══════════════════════════════════════════════════════════════════════

WHAT'S HAPPENING:
The defendant has a fixed window (typically 10-30 days from service in
LA city court) to file an answer or motion. Three branches from here:

BRANCH A — DEFENDANT NEVER RESPONDS (most common, ~60-70% of cases):
  You file a motion for default judgment after the answer deadline. The
  judge reviews the petition + your evidence and (if the petition is
  well-pleaded and evidence is on file) signs a default judgment
  awarding you the damages claimed.
  TIMELINE: ~30 days from default motion to signed judgment.

BRANCH B — DEFENDANT FILES AN ANSWER + GOES TO HEARING (~20-30% of cases):
  The court schedules a hearing. You appear in person; defendant appears
  in person or by counsel. You present your evidence; defendant cross-
  examines. Most TCPA small-claims hearings last 30-60 minutes.
  TIMELINE: hearing within 30-60 days of answer.

BRANCH C — DEFENDANT FILES A MOTION TO DISMISS (~5-10% of cases):
  Common arguments: lack of standing (post-TransUnion), professional
  plaintiff (Stoops/Nomorobo), no concrete injury, federal preemption.
  The petition pre-empts most of these in writing — you'll respond
  pro se with a brief opposition. The judge rules on the motion (often
  without a hearing).
  TIMELINE: ~30-45 days from MTD filing to ruling.

WHAT YOU'RE UP AGAINST:
- If the defendant has counsel, they'll be experienced TCPA defense
  lawyers. Their playbook is well-known: argue lack of standing, argue
  prior consent, argue safe harbor under 47 CFR 64.1200(c)(2). Your
  petition is pre-armed against each — read the petition before the
  hearing so you can quote specific paragraph numbers.
- Bring printed copies of ALL evidence to the hearing. Even though it's
  on file, the judge often wants paper handed up.
- Dress neatly. Stand when the judge enters. Address the judge as
  "Your Honor". Speak only when invited.

═══════════════════════════════════════════════════════════════════════
  STAGE 6 — JUDGMENT (day 90-120)
═══════════════════════════════════════════════════════════════════════

WHAT'S HAPPENING:
Whether by default or after hearing, the court issues a written judgment.
That judgment IS your win — but it's just a piece of paper. Collecting
on it is a separate stage entirely.

WHAT TO DO:
1. Get a certified copy of the judgment from the clerk (~$5).
2. If the defendant is in Louisiana, you can record the judgment in the
   parish where they have assets — that creates a judgment lien.
3. If they don't pay voluntarily, you proceed to Stage 7 (collection).

WHAT YOU'RE UP AGAINST:
- If the judgment is for less than the defendant owes, you can't go back
  for more. Make sure you claimed your full damages in the petition.
- Judgments expire (usually 10 years in LA, can be revived). You don't
  need to act immediately, but don't sit on it forever.

═══════════════════════════════════════════════════════════════════════
  STAGE 7 — COLLECTION (open-ended; the hardest stage)
═══════════════════════════════════════════════════════════════════════

WHAT'S HAPPENING:
You have a judgment but no money. You now need to find the defendant's
assets and either persuade them to pay, garnish their wages/accounts, or
seize property.

WHAT TO DO (in order of effort):
1. Send a polite demand for payment, including a copy of the judgment
   and a deadline (~30 days). Some defendants pay at this stage to avoid
   collection actions.
2. If no payment: file a writ of fieri facias (LA equivalent of a
   garnishment). Targets the defendant's bank accounts. You need to know
   where they bank — investigate via Sonar / public records / your
   defendant_research.txt.
3. Wage garnishment: if the defendant is an individual with W-2 income,
   you can garnish wages. Corporations don't have wages.
4. Property seizure: extreme; rare for small-claims judgments.
5. Sell the judgment to a collection agency (~10-25 cents on the dollar).
   Sometimes this is the realistic best outcome.

WHAT YOU'RE UP AGAINST (this is where most cases die):
- Spoofed-VoIP shells have no US assets. Collection is impossible.
  This is the 90-95% scenario for TCPA defendants.
- Even findable companies can be judgment-proof (heavily indebted,
  about to dissolve, offshore parent).
- Collection actions cost more money. Each writ filing is ~$50-100.
  Don't throw good money after bad.

═══════════════════════════════════════════════════════════════════════
  HONEST EXPECTATIONS
═══════════════════════════════════════════════════════════════════════

For YOUR CASE specifically against ${offender.companyName ?? "this defendant"}:
  - Filing fee:           ~$75
  - Service costs:        ~$30-50
  - Demand letter cost:   ~$8.50 (USPS)
  - Time investment:      ~6-10 hours over 90 days
  - Statutory damages:    $${damages.toLocaleString()}
  - Realistic collection: depends entirely on defendant identification.
                          Read defendant_research.txt's collectability
                          band before you file.

The most realistic positive outcome is a $${damages.toLocaleString()} default
judgment that you THEN have to collect. Even uncollected, the judgment
creates a public record that may slow the spammer's operation (judgment
liens, credit damage, parallel-enforcement attention).

The most realistic negative outcome is filing fees lost on an uncollect-
able shell. That's why STAGE 1 (evidence gathering + research) is the
most important stage — it's where you decide whether to spend the $75.

═══════════════════════════════════════════════════════════════════════
END OF STAGES GUIDE
═══════════════════════════════════════════════════════════════════════
`;
}

// ──────────────────────────────────────────────────────────────────────────
//  HELPERS
// ──────────────────────────────────────────────────────────────────────────

function buildCarrierSubpoena(
  carrierName: string,
  offender: OffenderProfile,
  user: UserContext
): string {
  const dates = (offender.calls ?? []).map((c) => `${c.date} ${c.time}`).join(", ");
  return [
    `${user.userAddress}`,
    `${user.userPhone}`,
    `${user.userEmail}`,
    ``,
    `${new Date().toISOString().split("T")[0]}`,
    ``,
    `${carrierName} Subpoena Compliance / Legal Department`,
    `[Look up current address at ${carrierName}'s legal page]`,
    ``,
    `Re: Subpoena Duces Tecum — Call Detail Records`,
    `Account: ${user.userPhone}`,
    `Subject calls from: ${offender.normalizedNumber}`,
    ``,
    `To Whom It May Concern:`,
    ``,
    `Pursuant to a small-claims TCPA action I am filing against the operator of telephone number ${offender.normalizedNumber}, I respectfully request the following Call Detail Records (CDR) from your records:`,
    ``,
    `  1. All inbound calls to ${user.userPhone} from ${offender.normalizedNumber}`,
    `     between ${offender.firstCallDate ?? "[start date]"} and ${offender.lastCallDate ?? "[end date]"}.`,
    `  2. For each such call: date, time (with timezone), duration, and any`,
    `     STIR/SHAKEN attestation level recorded by the originating carrier.`,
    `  3. Any tower/cell-site information or routing metadata you maintain in`,
    `     the regular course of business for these calls.`,
    ``,
    `These records will be offered into evidence under FRE 803(6) (business records exception) and FRE 902(11) (self-authentication via custodian declaration). I respectfully request a Rule 902(11) certification accompany the production.`,
    ``,
    `The specific call timestamps to verify are: ${dates}`,
    ``,
    `If you require a court-issued subpoena before producing these records, please notify me at the above address within 14 days and I will promptly obtain one through the small-claims court.`,
    ``,
    `Thank you for your cooperation.`,
    ``,
    `Respectfully,`,
    ``,
    `____________________________`,
    `${user.userName}`,
    `Pro Se`,
  ].join("\n");
}

function buildGoogleCalendarUrl(offender: OffenderProfile, _user: UserContext): string {
  const reminderDate = new Date();
  reminderDate.setDate(reminderDate.getDate() + 14);
  const yyyymmdd = reminderDate.toISOString().split("T")[0].replace(/-/g, "");
  const startTime = `${yyyymmdd}T140000Z`;
  const endTime = `${yyyymmdd}T150000Z`;
  const title = encodeURIComponent(`SpamSlayer follow-up: ${offender.companyName ?? offender.normalizedNumber}`);
  const details = encodeURIComponent(
    `Check: ITG traceback received? Carrier portal screenshot saved? FCC complaint acknowledged?\n\n` +
    `If all third-party evidence is in hand, generate the filing packet and review before signing.\n\n` +
    `Caller: ${offender.normalizedNumber}\nCalls: ${offender.callCount}\nDamages: $${offender.damagesEstimate ?? 0}`
  );
  return `https://calendar.google.com/calendar/u/0/r/eventedit?text=${title}&dates=${startTime}/${endTime}&details=${details}`;
}

/**
 * Render the checklist as a printable .txt file for inclusion in the saved
 * filing package. Includes whatToExpect + escalation sections.
 */
export function renderChecklistAsText(
  checklist: NonNullable<OffenderProfile["evidenceChecklist"]>,
  offender: OffenderProfile
): string {
  const lines: string[] = [
    "═══════════════════════════════════════════════════════════════════════",
    "                 EVIDENCE-GATHERING CHECKLIST",
    "═══════════════════════════════════════════════════════════════════════",
    `Offender:        ${offender.normalizedNumber}`,
    `Company:         ${offender.companyName ?? "(unknown)"}`,
    `Calls so far:    ${offender.callCount}`,
    `Generated:       ${checklist.generatedAt}`,
    "",
    "These are the third-party-evidence steps to do BEFORE filing your",
    "petition. None are legally required to file — but each one strengthens",
    "the evidence stack from a pro-se filing into something defense counsel",
    "cannot easily impeach. Work them top-to-bottom; each item shows what",
    "you'll see, how long it takes, and what to watch out for.",
    "",
    "Each item defaults to the EASY/FREE path (portal screenshot, web form).",
    "Hard / expensive escalations (subpoenas) are listed under each item",
    "but only needed if the defendant actually contests the case in court.",
    "",
    "═══════════════════════════════════════════════════════════════════════",
  ];

  checklist.items.forEach((item, i) => {
    lines.push("");
    lines.push(`  [ ${item.completed ? "X" : " "} ]  ${i + 1}. ${item.title}`);
    lines.push("");
    lines.push("        WHY:");
    item.why.match(/.{1,68}(\s|$)/g)?.forEach((c) => lines.push(`          ${c.trim()}`));
    if (item.url) {
      lines.push("");
      lines.push(`        URL: ${item.url}`);
    }
    if (item.template) {
      lines.push("");
      lines.push("        COPY-PASTE TEMPLATE:");
      lines.push("        ──────────────────────");
      item.template.split("\n").forEach((l) => lines.push(`          ${l}`));
      lines.push("        ──────────────────────");
    }
    if (item.whatToExpect) {
      lines.push("");
      lines.push("        WHAT TO EXPECT:");
      item.whatToExpect.split("\n").forEach((l) => lines.push(`          ${l}`));
    }
    if (item.escalation) {
      lines.push("");
      lines.push("        ⬇  ESCALATION (only if needed):");
      lines.push(`          TRIGGER: ${item.escalation.trigger}`);
      lines.push(`          ${item.escalation.title}`);
      lines.push("");
      item.escalation.instructions.split("\n").forEach((l) => lines.push(`          ${l}`));
      if (item.escalation.template) {
        lines.push("");
        lines.push("          ESCALATION TEMPLATE (subpoena/letter):");
        lines.push("          ──────────────────────");
        item.escalation.template.split("\n").forEach((l) => lines.push(`            ${l}`));
        lines.push("          ──────────────────────");
      }
    }
    if (item.completed && item.completedAt) {
      lines.push(`        ✓ Completed at ${item.completedAt}`);
    }
    lines.push("");
    lines.push("───────────────────────────────────────────────────────────────────────");
  });

  lines.push("");
  lines.push("END OF EVIDENCE CHECKLIST");
  return lines.join("\n");
}
