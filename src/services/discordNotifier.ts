// ─────────────────────────────────────────────────────────────────────────────
//  discordNotifier.ts — fire-and-forget Discord webhook notifier.
//
//  Fires after every spam call is logged. Sends two flavors:
//    1. Per-call alert — concise embed with grade, extracted info, snippet.
//    2. Newly-actionable case alert — higher-priority embed (red) with
//       damages estimate and "this case can now be filed" CTA.
//
//  Configuration (env):
//    DISCORD_WEBHOOK_URL    Discord webhook URL. If unset, notifier is a no-op.
//    DISCORD_NOTIFY_UNTIL   ISO date (YYYY-MM-DD). After this date, no
//                           notifications are sent. Defaults to 2026-06-02
//                           (one month from initial trial enable).
//
//  Failure mode: a webhook failure NEVER throws into the calling route. We
//  log a warning and move on. Spam-call logging is too important to be
//  blocked by a Discord outage.
// ─────────────────────────────────────────────────────────────────────────────

import type { ConversationGrade } from "./conversationGrader";

const DEFAULT_NOTIFY_UNTIL = "2026-06-02"; // trial cutoff; user enabled 2026-05-02

function webhookUrl(): string | null {
  const u = process.env.DISCORD_WEBHOOK_URL?.trim();
  if (!u) return null;
  // Sanity check: must be a discord.com webhook URL.
  if (!/^https:\/\/(?:discord(?:app)?\.com|discord\.com)\/api\/webhooks\//.test(u)) {
    console.warn(`[Discord] DISCORD_WEBHOOK_URL set but doesn't match expected pattern; refusing to send.`);
    return null;
  }
  return u;
}

function notifyUntil(): Date {
  const raw = (process.env.DISCORD_NOTIFY_UNTIL ?? DEFAULT_NOTIFY_UNTIL).trim();
  // Parse as UTC midnight to avoid local-timezone surprises around the cutoff.
  const d = new Date(raw + "T23:59:59Z");
  if (isNaN(d.getTime())) {
    console.warn(`[Discord] DISCORD_NOTIFY_UNTIL="${raw}" is not a valid date; falling back to ${DEFAULT_NOTIFY_UNTIL}.`);
    return new Date(DEFAULT_NOTIFY_UNTIL + "T23:59:59Z");
  }
  return d;
}

function isWithinTrialWindow(now: Date = new Date()): boolean {
  return now.getTime() <= notifyUntil().getTime();
}

// ── Embed colors (decimal) ─────────────────────────────────────────────────
const COLOR_GREEN = 0x2ecc71;   // good case captured
const COLOR_YELLOW = 0xf1c40f;  // weak grade
const COLOR_RED = 0xe74c3c;     // newly actionable / high concern
const COLOR_GREY = 0x95a5a6;    // incomplete / hung up

function colorForGrade(letter: string): number {
  switch (letter) {
    case "A": case "B": return COLOR_GREEN;
    case "C": case "D": return COLOR_YELLOW;
    case "F": return COLOR_RED;
    default: return COLOR_GREY;
  }
}

function truncate(s: string | null | undefined, max: number): string {
  if (!s) return "—";
  const t = s.trim();
  if (t.length <= max) return t || "—";
  return t.slice(0, max - 1) + "…";
}

// ── Public API ─────────────────────────────────────────────────────────────

export interface CallLoggedPayload {
  callerPhone: string;
  companyName: string | null;
  callerName: string | null;
  callCount: number;
  actionable: boolean;
  isNewlyActionable: boolean;
  damagesEstimate: number;
  grade: ConversationGrade;
  transcriptSnippet: string;
  /** Top N (typically 3) checklist quicklinks to include in the actionable
   *  embed. Surfaced as tappable field rows on Discord mobile so Marcus can
   *  jump straight to ITG / FCC / carrier portal without opening the dashboard.
   *  Optional — embed renders without this list if not provided. */
  checklistTopItems?: Array<{ title: string; url?: string }>;
}

/**
 * AUDIT_ROUND_23: audit ping for pressure-stack auto-fire. Posts a Discord
 * embed summarizing what was sent on the user's behalf. Always fires when
 * any auto-send actually went out, so Marcus has a complete audit trail.
 */
export async function notifyAutoFire(p: {
  callerPhone: string;
  companyName: string | null;
  results: Array<{
    title: string;
    recipient: string;
    sent: boolean;
    detail: string;
  }>;
}): Promise<void> {
  const url = webhookUrl();
  if (!url) return;
  if (!isWithinTrialWindow()) return;

  const sent = p.results.filter((r) => r.sent);
  const skipped = p.results.filter((r) => !r.sent);

  if (sent.length === 0 && skipped.length === 0) return; // nothing to report

  const fields: any[] = sent.map((r) => ({
    name: `📤 Sent: ${truncate(r.title, 60)}`,
    value: `to \`${truncate(r.recipient, 60)}\``,
    inline: false,
  }));
  if (skipped.length > 0) {
    fields.push({
      name: `⚠️ Skipped (${skipped.length})`,
      value: skipped.map((r) => `• ${truncate(r.title, 50)} — ${truncate(r.detail, 80)}`).join("\n"),
      inline: false,
    });
  }

  await postEmbeds(url, [{
    title: `📤 Auto-fired pressure stack`,
    description:
      `Sent enforcement actions on your behalf for **${truncate(p.companyName, 80) || p.callerPhone}**. ` +
      `Each email also BCC'd you for an audit copy.`,
    color: sent.length > 0 ? COLOR_GREEN : COLOR_GREY,
    fields,
    footer: { text: `SpamSlayer · auto-fire is gated on AUTO_SEND_PRESSURE=true in .env` },
  }]);
}

/**
 * AUDIT_ROUND_24: alarm transition embed for the healthMonitor. Fired on
 * broke→ok or ok→broke transitions only — no spam on repeat scans.
 */
export async function notifyAlarm(p: {
  alarmId: string;
  transitionTo: "ok" | "broken";
  message: string;
  durationMs?: number;
  /** Optional extra context lines shown as fields. */
  context?: Array<{ name: string; value: string }>;
}): Promise<void> {
  const url = webhookUrl();
  if (!url) return;
  if (!isWithinTrialWindow()) return;

  const color = p.transitionTo === "broken" ? COLOR_RED : COLOR_GREEN;
  const glyph = p.transitionTo === "broken" ? "🔴 BROKE" : "✅ FIXED";
  const fields: any[] = [];
  if (p.context) fields.push(...p.context.slice(0, 5).map((c) => ({ name: c.name.slice(0, 60), value: c.value.slice(0, 1000), inline: false })));
  if (p.transitionTo === "ok" && typeof p.durationMs === "number") {
    fields.push({ name: "Was down for", value: humanDur(p.durationMs), inline: true });
  }

  await postEmbeds(url, [{
    title: `${glyph}: ${truncate(p.alarmId, 80)}`,
    description: p.message.slice(0, 1500),
    color,
    fields,
    footer: { text: `SpamSlayer health monitor · ${new Date().toISOString()}` },
  }]);
}

function humanDur(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60); const mr = m % 60;
  return `${h}h ${mr}m`;
}

/**
 * Reminder embed (separate from notifyCallLogged) — fired by the cadence
 * pump every 24h / 72h on actionable cases that still have incomplete
 * checklist items. Keeps Marcus from forgetting the ITG window.
 */
export async function notifyChecklistReminder(p: {
  callerPhone: string;
  companyName: string | null;
  callCount: number;
  damagesEstimate: number;
  hoursElapsed: number;
  incompleteItems: Array<{ title: string; url?: string }>;
}): Promise<void> {
  const url = webhookUrl();
  if (!url) return;
  if (!isWithinTrialWindow()) return;

  const fields = p.incompleteItems.slice(0, 5).map((item, i) => ({
    name: `${i + 1}. ${truncate(item.title, 60)}`,
    value: item.url ? `[Open →](${item.url})` : "(see dashboard)",
    inline: false,
  }));

  await postEmbeds(url, [{
    title: `⏰ Reminder: actionable case still has open evidence items`,
    description:
      `It's been ${Math.round(p.hoursElapsed)}h since **${truncate(p.companyName, 80) || p.callerPhone}** ` +
      `became actionable (${p.callCount} calls, $${p.damagesEstimate.toLocaleString()} in damages). ` +
      `These items are still open — knock them out before evidence goes stale ` +
      `(ITG traceback success drops sharply after 14 days):`,
    color: COLOR_YELLOW,
    fields,
    footer: { text: `SpamSlayer evidence-checklist reminder · open the dashboard for the full list` },
  }]);
}

/**
 * Post one or two Discord embeds for a freshly-logged spam call.
 * No-op if webhook isn't configured or the trial window has elapsed.
 */
export async function notifyCallLogged(p: CallLoggedPayload): Promise<void> {
  const url = webhookUrl();
  if (!url) return;
  if (!isWithinTrialWindow()) {
    // Log once per process so the user notices the trial expired.
    if (!warnedExpired) {
      warnedExpired = true;
      console.log(
        `[Discord] Trial window ended (DISCORD_NOTIFY_UNTIL=${process.env.DISCORD_NOTIFY_UNTIL ?? DEFAULT_NOTIFY_UNTIL}). ` +
        `Discord notifications are now disabled. To re-enable, extend the date in .env and restart.`
      );
    }
    return;
  }

  const embeds: any[] = [];

  // ── 1. Per-call alert ──
  embeds.push({
    title: `Spam call logged: ${truncate(p.companyName, 80) || "(unknown company)"}`,
    description: p.grade.summary,
    color: colorForGrade(p.grade.grade),
    fields: [
      { name: "Caller", value: `\`${truncate(p.callerPhone, 30)}\``, inline: true },
      { name: "Caller name", value: truncate(p.callerName, 30), inline: true },
      { name: "Calls from this number", value: `${p.callCount}`, inline: true },
      { name: "Grade", value: `**${p.grade.grade}** (${p.grade.score}/100)`, inline: true },
      { name: "Hang-up risk", value: p.grade.hangUpRisk, inline: true },
      { name: "Missing", value: p.grade.missingInfo.length > 0 ? p.grade.missingInfo.join(", ") : "nothing", inline: true },
      { name: "Snippet", value: truncate(p.transcriptSnippet || "(no transcript)", 1000), inline: false },
    ],
    footer: { text: `SpamSlayer · ${new Date().toISOString()}` },
  });

  // ── 2. Higher-priority embed if this call just made the case actionable ──
  if (p.isNewlyActionable) {
    const fields: any[] = [];
    if (Array.isArray(p.checklistTopItems) && p.checklistTopItems.length > 0) {
      // Show top 3 quicklinks as field rows so they're tappable on mobile.
      fields.push(...p.checklistTopItems.slice(0, 3).map((item, i) => ({
        name: `${i + 1}. ${truncate(item.title, 60)}`,
        value: item.url ? `[Open →](${item.url})` : "(see dashboard for details)",
        inline: false,
      })));
    }
    embeds.push({
      title: `🚨 New actionable TCPA case`,
      description:
        `**${truncate(p.companyName, 80) || p.callerPhone}** has now called you ${p.callCount} ` +
        `time(s). You may file in small claims court for **$${p.damagesEstimate.toLocaleString()}** ` +
        `in statutory damages.\n\n` +
        `**Do these now to strengthen your case:**`,
      color: COLOR_RED,
      fields,
      footer: { text: `Open SpamSlayer dashboard for the full evidence checklist.` },
    });
  }

  await postEmbeds(url, embeds);
}

// ── Internals ──────────────────────────────────────────────────────────────

let warnedExpired = false;

async function postEmbeds(url: string, embeds: any[]): Promise<void> {
  // Discord caps embeds at 10 per request; we'll never approach that.
  const body = JSON.stringify({
    username: "SpamSlayer",
    // Identicon-like default avatar; users can override on the webhook.
    embeds,
  });

  // Use AbortController so a hung Discord request doesn't pile up forever.
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 5000);

  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signal: ac.signal,
    });
    if (!r.ok) {
      const text = await r.text().catch(() => "");
      console.warn(`[Discord] webhook responded ${r.status}: ${text.slice(0, 200)}`);
    }
  } catch (err: any) {
    if (err?.name === "AbortError") {
      console.warn("[Discord] webhook timed out after 5s");
    } else {
      console.warn(`[Discord] webhook send failed: ${err?.message ?? err}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

// ── Diagnostic helper (unused at runtime; handy from a one-off script) ────

export function notifierStatus(): {
  configured: boolean;
  withinWindow: boolean;
  notifyUntil: string;
} {
  return {
    configured: webhookUrl() !== null,
    withinWindow: isWithinTrialWindow(),
    notifyUntil: notifyUntil().toISOString(),
  };
}
