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
import * as fs from "fs";
import * as path from "path";

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

// ── P4.2: SMS retry queue ─────────────────────────────────────────────────
//
// Old behavior: send-and-forget. If Twilio's API was 503'd or rate-limited,
// the SMS was lost forever and the user never learned that a case became
// actionable. Now we persist every failed send to disk and retry on a
// schedule. The retry queue:
//   * survives process restart
//   * exponential backoff: 1m, 5m, 30m, 2h
//   * gives up after 4 attempts and writes to a dead-letter log
//   * never blocks the caller — sendSMS still resolves immediately

const RETRY_FILE = path.resolve(__dirname, "..", "..", "..", "sms_retry_queue.json");
const RETRY_DEAD_LETTER = path.resolve(__dirname, "..", "..", "..", "sms_dead_letter.log");
const RETRY_DELAYS_MS = [60_000, 300_000, 1_800_000, 7_200_000]; // 1m, 5m, 30m, 2h

interface RetryEntry {
  to: string;
  body: string;
  attempt: number;        // 0-indexed: 0 = first failure, scheduled to retry as attempt 1
  firstFailedAt: string;
  nextAttemptAt: number;  // ms epoch
}

function loadRetryQueue(): RetryEntry[] {
  if (!fs.existsSync(RETRY_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(RETRY_FILE, "utf-8")) as RetryEntry[]; }
  catch { return []; }
}
function saveRetryQueue(q: RetryEntry[]): void {
  try {
    fs.writeFileSync(RETRY_FILE + ".tmp", JSON.stringify(q, null, 2), { mode: 0o600 });
    fs.renameSync(RETRY_FILE + ".tmp", RETRY_FILE);
    try { fs.chmodSync(RETRY_FILE, 0o600); } catch { /* best-effort */ }
  } catch (err) {
    console.warn(`[Notify] retry queue save failed: ${(err as Error).message}`);
  }
}

function enqueueRetry(to: string, body: string): void {
  const q = loadRetryQueue();
  q.push({
    to, body,
    attempt: 0,
    firstFailedAt: new Date().toISOString(),
    nextAttemptAt: Date.now() + RETRY_DELAYS_MS[0],
  });
  saveRetryQueue(q);
}

async function processRetryQueue(): Promise<void> {
  const q = loadRetryQueue();
  if (q.length === 0) return;
  const now = Date.now();
  const due = q.filter((e) => e.nextAttemptAt <= now);
  const remaining = q.filter((e) => e.nextAttemptAt > now);
  for (const entry of due) {
    try {
      await getClient().messages.create({ to: entry.to, from: getFromNumber(), body: entry.body });
      console.log(`[Notify] SMS retry attempt ${entry.attempt + 1} succeeded for ${entry.to}`);
    } catch (err) {
      const next = entry.attempt + 1;
      if (next >= RETRY_DELAYS_MS.length) {
        // Give up — write to dead-letter log.
        try {
          fs.appendFileSync(RETRY_DEAD_LETTER,
            `${new Date().toISOString()} GAVE UP after ${next} attempts: to=${entry.to} body="${entry.body.slice(0, 100)}" err=${(err as Error).message}\n`,
            { mode: 0o600 });
        } catch { /* best-effort */ }
        console.error(`[Notify] SMS GAVE UP after ${next} attempts: ${entry.to}`);
      } else {
        remaining.push({
          ...entry,
          attempt: next,
          nextAttemptAt: Date.now() + RETRY_DELAYS_MS[next],
        });
      }
    }
  }
  saveRetryQueue(remaining);
}

// Run the retry pump every 30 seconds. unref() so it doesn't keep the
// process alive past graceful shutdown.
setInterval(() => { processRetryQueue().catch(() => undefined); }, 30_000).unref?.();

async function sendSMS(to: string, body: string): Promise<void> {
  try {
    await getClient().messages.create({
      to,
      from: getFromNumber(),
      body,
    });
    console.log(`[Notify] SMS sent to ${to}: "${body.slice(0, 60)}..."`);
  } catch (err) {
    console.error(`[Notify] SMS failed to ${to}:`, err, "— enqueuing for retry");
    enqueueRetry(to, body);
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
  missingField: "name" | "sex" | "address" | "dncYear"
): Promise<void> {
  const prompts: Record<string, string> = {
    name: "SpamSlayer: To generate legal documents, I need your full name. Reply: NAME John Smith",
    sex: "SpamSlayer: One more — reply SEX M or SEX F so your bot sounds like you when it answers spam calls.",
    address: "SpamSlayer: For your demand letters, I need your mailing address. Reply: ADDRESS 123 Main St, Lafayette LA 70501",
    dncYear: "SpamSlayer: What year did you register on the Do Not Call list? Reply: DNC 2007 (or DNC UNSURE if you're not sure)",
  };
  await sendSMS(userPhone, prompts[missingField] ?? "SpamSlayer: Reply HELP for commands.");
}
