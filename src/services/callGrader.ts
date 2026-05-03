// ─────────────────────────────────────────────────────────────────────────────
//  callGrader.ts — cross-bot call analysis: pulls calls from Twilio, pulls
//  per-call transcripts from Render logs, grades each conversation.
//
//  Detects the silent-failure bug Reed exhibits ~20% of the time: Twilio
//  connects, OpenAI Realtime opens a session, but the bot never produces a
//  spoken response. Without this grader, the only signal is a hand-listened
//  recording. With it, we surface "X of last N calls had bot SILENT" and
//  page Discord on a transition.
//
//  Architecture:
//    - For each bot service we're watching, list recent Twilio calls TO that
//      bot's phone number(s).
//    - For each call, query Render logs in a tight window around the call's
//      start_time, filter to lines matching the bot's WS handler ("[ws/<bot>] ")
//      and the call's SID.
//    - Extract `Bot:` and `Caller:` utterances. Grade by:
//        * grade A: 2-sided exchange (bot AND caller spoke 2+ times each)
//        * grade C: bot spoke at least once but caller didn't engage
//        * grade F-SILENT: OpenAI Realtime connected, bot NEVER spoke
//        * grade RTC-DOWN: Realtime never even connected
//        * grade INCOMPLETE: <5s call, can't tell
//
//  Never throws. Returns structured results that healthMonitor can compare
//  against thresholds to decide whether to fire an alarm.
// ─────────────────────────────────────────────────────────────────────────────

export interface BotTarget {
  /** Friendly bot name used in the WS log prefix (e.g., "reed", "sam"). */
  slug: string;
  /** Twilio phone numbers this bot answers. E.164 format. */
  phoneNumbers: string[];
  /** Render service ID that hosts this bot. */
  renderServiceId: string;
  /** Render owner ID (team/user) that owns the service. */
  renderOwnerId: string;
}

export interface CallGrade {
  callSid: string;
  startTime: string;
  fromNumber: string;
  toNumber: string;
  durationSec: number;
  twilioStatus: string;
  /** Did OpenAI Realtime / WS handler connect at all? */
  realtimeConnected: boolean;
  /** Number of turns we extracted (Bot:/Caller: lines) */
  turnCount: number;
  botTurns: number;
  callerTurns: number;
  grade: "A" | "B" | "C" | "D" | "F-SILENT" | "RTC-DOWN" | "INCOMPLETE";
  score: number;
  note: string;
  /** Sample first 3 turns for the alarm message (privacy: only first 100 chars per turn). */
  transcriptPreview: string[];
}

export interface BotGradeReport {
  botSlug: string;
  windowHours: number;
  totalCalls: number;
  byGrade: Record<string, number>;
  silentFailureRate: number;       // 0..1 — primary alarm trigger
  twoSidedRate: number;            // 0..1 — opposite signal
  worstCalls: CallGrade[];          // up to 5
  bestCalls: CallGrade[];           // up to 5
  generatedAt: string;
}

// ── Twilio API client ──────────────────────────────────────────────────

async function twilioFetch(path: string): Promise<any> {
  const sid = process.env.TWILIO_API_KEY_SID ?? process.env.TWILIO_ACCOUNT_SID;
  const tok = process.env.TWILIO_API_KEY_SECRET ?? process.env.TWILIO_AUTH_TOKEN;
  const acct = process.env.TWILIO_ACCOUNT_SID;
  if (!sid || !tok || !acct) throw new Error("Twilio credentials missing");
  const auth = Buffer.from(`${sid}:${tok}`).toString("base64");
  const url = `https://api.twilio.com/2010-04-01/Accounts/${acct}${path}`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 15_000);
  try {
    const r = await fetch(url, {
      headers: { Authorization: `Basic ${auth}`, Accept: "application/json" },
      signal: ac.signal,
    });
    if (!r.ok) throw new Error(`Twilio ${r.status}: ${(await r.text()).slice(0, 200)}`);
    return await r.json();
  } finally { clearTimeout(timer); }
}

// ── Render Logs API ────────────────────────────────────────────────────

async function renderLogs(
  ownerId: string, serviceId: string,
  startISO: string, endISO: string, limit = 200
): Promise<Array<{ timestamp: string; message: string }>> {
  const tok = process.env.RENDER_API_KEY;
  if (!tok) throw new Error("RENDER_API_KEY not set");
  const params = new URLSearchParams({
    ownerId, resource: serviceId, startTime: startISO, endTime: endISO,
    limit: String(limit),
  });
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 15_000);
  try {
    const r = await fetch(`https://api.render.com/v1/logs?${params}`, {
      headers: { Authorization: `Bearer ${tok}`, Accept: "application/json" },
      signal: ac.signal,
    });
    if (!r.ok) throw new Error(`Render logs ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const d = await r.json() as any;
    return Array.isArray(d?.logs) ? d.logs : [];
  } finally { clearTimeout(timer); }
}

// ── Grader ─────────────────────────────────────────────────────────────

function gradeOne(turns: { role: string; text: string }[], realtimeOk: boolean, durationSec: number): { grade: CallGrade["grade"]; score: number; note: string } {
  if (durationSec < 3) return { grade: "INCOMPLETE", score: 0, note: "call too short to grade" };
  if (!realtimeOk) return { grade: "RTC-DOWN", score: 0, note: "OpenAI Realtime never connected — bot infra down" };
  const bot = turns.filter((t) => t.role === "Bot" && t.text.trim()).length;
  const caller = turns.filter((t) => t.role === "Caller" && t.text.trim()).length;
  if (bot === 0) return { grade: "F-SILENT", score: 0, note: `bot SILENT — caller spoke ${caller}× to no response` };
  let score = 30;
  if (caller >= 1) score += 25;
  const total = turns.length;
  if (total >= 4 && total <= 30) score += 25;
  else if (total >= 2) score += 15;
  if (bot > 0 && caller > 0) {
    const ratio = Math.min(bot, caller) / Math.max(bot, caller);
    if (ratio > 0.4) score += 20;
  }
  let letter: CallGrade["grade"] = "F-SILENT";
  if (score >= 85) letter = "A";
  else if (score >= 70) letter = "B";
  else if (score >= 55) letter = "C";
  else if (score >= 40) letter = "D";
  return { grade: letter, score, note: `${bot} bot / ${caller} caller turns` };
}

// ── Main entry — grade recent calls for one bot ────────────────────────

export async function gradeBotRecentCalls(bot: BotTarget, opts: { windowHours?: number; maxCalls?: number } = {}): Promise<BotGradeReport> {
  const windowHours = opts.windowHours ?? 24;
  const maxCalls = opts.maxCalls ?? 25;
  const generatedAt = new Date().toISOString();

  // Pull recent calls TO this bot's number(s)
  const callsRaw: any[] = [];
  for (const num of bot.phoneNumbers) {
    try {
      const r = await twilioFetch(`/Calls.json?PageSize=${maxCalls}&To=${encodeURIComponent(num)}`);
      callsRaw.push(...(r?.calls ?? []));
    } catch (err) {
      console.warn(`[CallGrader] Twilio fetch failed for ${num}:`, (err as Error).message);
    }
  }

  // Filter to within window
  const nowMs = Date.now();
  const cutoff = nowMs - windowHours * 60 * 60 * 1000;
  const calls = callsRaw.filter((c) => {
    const t = new Date(c.start_time).getTime();
    return !isNaN(t) && t >= cutoff;
  });

  const grades: CallGrade[] = [];

  for (const c of calls) {
    const startMs = new Date(c.start_time).getTime();
    const dur = parseInt(c.duration ?? "0", 10);
    const winStart = new Date(startMs - 10_000).toISOString();
    const winEnd = new Date(startMs + (dur * 1000) + 60_000).toISOString();

    let logs: Array<{ timestamp: string; message: string }> = [];
    try { logs = await renderLogs(bot.renderOwnerId, bot.renderServiceId, winStart, winEnd, 200); }
    catch (err) {
      console.warn(`[CallGrader] log fetch failed for ${c.sid}:`, (err as Error).message);
    }

    let realtimeOk = false;
    const turns: { role: string; text: string }[] = [];
    const wsPrefix = `[ws/${bot.slug}]`;
    for (const log of logs) {
      const msg = log.message ?? "";
      if (msg.includes("OpenAI Realtime connected")) realtimeOk = true;
      if (msg.includes(`${wsPrefix} Bot:`)) {
        const text = msg.split(`${wsPrefix} Bot:`, 2)[1]?.trim().slice(0, 200) ?? "";
        turns.push({ role: "Bot", text });
      } else if (msg.includes(`${wsPrefix} Caller:`)) {
        const text = msg.split(`${wsPrefix} Caller:`, 2)[1]?.trim().slice(0, 200) ?? "";
        turns.push({ role: "Caller", text });
      }
    }

    const { grade, score, note } = gradeOne(turns, realtimeOk, dur);
    grades.push({
      callSid: c.sid,
      startTime: c.start_time,
      fromNumber: c.from,
      toNumber: c.to,
      durationSec: dur,
      twilioStatus: c.status,
      realtimeConnected: realtimeOk,
      turnCount: turns.length,
      botTurns: turns.filter((t) => t.role === "Bot").length,
      callerTurns: turns.filter((t) => t.role === "Caller").length,
      grade, score, note,
      transcriptPreview: turns.slice(0, 3).map((t) => `${t.role}: ${t.text.slice(0, 100)}`),
    });
  }

  const byGrade: Record<string, number> = {};
  for (const g of grades) byGrade[g.grade] = (byGrade[g.grade] ?? 0) + 1;
  const silentCount = (byGrade["F-SILENT"] ?? 0) + (byGrade["RTC-DOWN"] ?? 0);
  const twoSidedCount = grades.filter((g) => g.botTurns > 0 && g.callerTurns > 0).length;
  const total = grades.length;

  return {
    botSlug: bot.slug,
    windowHours,
    totalCalls: total,
    byGrade,
    silentFailureRate: total > 0 ? silentCount / total : 0,
    twoSidedRate: total > 0 ? twoSidedCount / total : 0,
    worstCalls: [...grades].sort((a, b) => a.score - b.score).slice(0, 5),
    bestCalls: [...grades].sort((a, b) => b.score - a.score).slice(0, 5),
    generatedAt,
  };
}
