// ─────────────────────────────────────────────────────────────────────────────
//  notifications.ts — SMS notifications to SpamSlayer users
//
//  Sends alerts when:
//    - A spam call is logged (per-call notification)
//    - A case becomes actionable (2+ calls = TCPA violation!)
//    - A demand letter deadline expires
//    - Weekly case summary digest
// ─────────────────────────────────────────────────────────────────────────────

import twilio from "twilio";

let _client: ReturnType<typeof twilio> | null = null;

function getClient() {
  if (!_client) {
    _client = twilio(
      process.env.TWILIO_ACCOUNT_SID,
      process.env.TWILIO_AUTH_TOKEN
    );
  }
  return _client;
}

function getFromNumber(): string {
  return process.env.NOTIFY_FROM_NUMBER ?? process.env.TWILIO_PHONE_NUMBER ?? "";
}

async function sendSMS(to: string, body: string): Promise<void> {
  try {
    await getClient().messages.create({
      to,
      from: getFromNumber(),
      body,
    });
    console.log(`[Notify] SMS sent to ${to}: "${body.slice(0, 60)}..."`);
  } catch (err) {
    console.error(`[Notify] SMS failed to ${to}:`, err);
  }
}

// ── Notification types ───────────────────────────────────────────────────

/** Sent after every spam call is handled. */
export async function notifyCallLogged(
  userPhone: string,
  callerNumber: string,
  companyName: string | null,
  callCount: number
): Promise<void> {
  const company = companyName ?? callerNumber;
  let body: string;

  if (callCount === 1 && companyName) {
    // First strike — Dorothy got their info
    body = `🎯 Swoosh! ${company} left their info. One more call from them and we have a strong case!`;
  } else if (callCount === 1) {
    // First call but no info extracted
    body = `SpamSlayer: Call logged from ${callerNumber}. Dorothy is on it — one more call from this number builds your case.`;
  } else {
    body =
      `SpamSlayer: ${company} called again (${callCount} times now). ` +
      (callCount >= 2
        ? `You have an actionable TCPA case! Reply CASES for details.`
        : `1 more call = actionable case.`);
  }

  await sendSMS(userPhone, body);
}

/** Sent the moment a case becomes actionable (hits 2-call threshold). */
export async function notifyCaseActionable(
  userPhone: string,
  companyName: string | null,
  callerNumber: string,
  callCount: number,
  estimatedDamages: number
): Promise<void> {
  const company = companyName ?? callerNumber;
  const body =
    `SpamSlayer CASE READY: ${company} has called you ${callCount} times. ` +
    `Estimated damages: $${estimatedDamages.toLocaleString()} under TCPA 47 USC 227(c)(5). ` +
    `Reply LETTER to generate a demand letter, or DETAILS for full case info.`;
  await sendSMS(userPhone, body);
}

/** Sent when a demand letter deadline (30 days) passes with no response. */
export async function notifyDeadlineExpired(
  userPhone: string,
  companyName: string | null,
  estimatedDamages: number
): Promise<void> {
  const company = companyName ?? "the offender";
  const body =
    `SpamSlayer: 30-day deadline passed for ${company}. ` +
    `No payment received. You can now file in Lafayette City Court ` +
    `for $${estimatedDamages.toLocaleString()}. Filing fee ~$85.50. ` +
    `Reply FILE for your court-ready petition.`;
  await sendSMS(userPhone, body);
}

/** Weekly digest of case status. */
export async function notifyWeeklySummary(
  userPhone: string,
  totalCalls: number,
  actionableCases: number,
  totalDamages: number
): Promise<void> {
  const body =
    `SpamSlayer Weekly: ${totalCalls} spam calls logged. ` +
    `${actionableCases} actionable case${actionableCases !== 1 ? "s" : ""}. ` +
    `Total potential damages: $${totalDamages.toLocaleString()}. ` +
    (actionableCases > 0
      ? `Reply CASES to see your ready-to-file cases.`
      : `Keep forwarding those spam calls — building your cases.`);
  await sendSMS(userPhone, body);
}

/** Welcome message after signup. */
export async function notifyWelcome(
  userPhone: string,
  spamSlayerNumber: string
): Promise<void> {
  const digits = spamSlayerNumber.replace("+1", "");

  // Message 1: welcome + instructions
  await sendSMS(userPhone,
    `Welcome to SpamSlayer! I'll answer your spam calls, record everything, and build your TCPA case.\n\n` +
    `AT&T: Dial the code in the next message to forward unanswered calls to me.\n` +
    `iPhone: Settings → Phone → Call Forwarding.\n\n` +
    `Reply NAME [your name] to finish setup. Reply HELP anytime.`
  );

  // Message 2: just the forwarding code — easy to copy and dial
  await sendSMS(userPhone, `*61*${digits}#`);
}

/** Onboarding prompt for missing info. */
export async function notifyOnboardingPrompt(
  userPhone: string,
  missingField: "name" | "address" | "dncYear"
): Promise<void> {
  const prompts: Record<string, string> = {
    name: "SpamSlayer: To generate legal documents, I need your full name. Reply: NAME John Smith",
    address: "SpamSlayer: For your demand letters, I need your mailing address. Reply: ADDRESS 123 Main St, Lafayette LA 70501",
    dncYear: "SpamSlayer: What year did you register on the Do Not Call list? Reply: DNC 2007 (or DNC UNSURE if you're not sure)",
  };
  await sendSMS(userPhone, prompts[missingField] ?? "SpamSlayer: Reply HELP for commands.");
}
