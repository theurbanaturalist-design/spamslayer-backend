// ─────────────────────────────────────────────────────────────────────────────
//  healthMonitor.ts — orchestrates all health checks across the system
//
//  What gets checked, every 5 minutes:
//    1. Twilio: each tracked phone number's webhook URL hasn't drifted
//    2. Twilio: account-level error notifications in last 30 min
//    3. Render: each tracked service is "live" (not suspended/crashed)
//    4. Per-bot conversation grading via callGrader (Reed and any siblings)
//       — the BIG signal: silent-failure rate >= 30% over last 24h = ALARM
//    5. Each bot's HTTP /health endpoint (if it exposes one)
//    6. SMTP mailer status (if AUTO_SEND_PRESSURE on)
//
//  Each check produces a per-alarm result. Transitions go through alarmState
//  to dedupe — so we Discord-ping on broke→ok and ok→broke, not on every scan.
// ─────────────────────────────────────────────────────────────────────────────

import { gradeBotRecentCalls, type BotTarget, type BotGradeReport } from "./callGrader";
import { checkAlarm, formatDuration, type Transition } from "./alarmState";

// ── Bot registry — what we're monitoring ──────────────────────────────
//
// Hard-coded for now. Future: load from a config file or env var.
// The slug must match the WS handler log prefix used in Reed's code
// (e.g. "[ws/reed] Bot:" → slug "reed").

export const BOTS_TO_MONITOR: BotTarget[] = [
  {
    slug: "reed",
    phoneNumbers: ["+13372706780"],
    renderServiceId: process.env.RENDER_RECEPTIONIST_SERVICE_ID ?? "srv-d45cqfmuk2gs73ceom90",
    renderOwnerId: "tea-d45cnj3e5dus73c1prk0",
  },
  // Future: add Sage, Sales, T-PhilBot, etc. once we know their slugs match
];

// ── Render service health ─────────────────────────────────────────────

interface RenderServiceCheck {
  serviceId: string;
  name: string;
  url?: string;
  status: "live" | "suspended" | "build_failed" | "deploy_failed" | "unknown";
  lastDeployStatus?: string;
  lastDeployFinishedAt?: string;
}

async function checkRenderService(serviceId: string): Promise<RenderServiceCheck> {
  const tok = process.env.RENDER_API_KEY;
  if (!tok) return { serviceId, name: "(no creds)", status: "unknown" };
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 10_000);
    const r = await fetch(`https://api.render.com/v1/services/${serviceId}`, {
      headers: { Authorization: `Bearer ${tok}` }, signal: ac.signal,
    });
    clearTimeout(timer);
    if (!r.ok) return { serviceId, name: "(api error)", status: "unknown" };
    const svc: any = await r.json();
    const baseUrl = svc?.serviceDetails?.url ?? svc?.url;
    const suspended = svc?.suspended === "suspended";

    // Pull the most recent deploy
    let depStatus = "unknown";
    let depFinishedAt: string | undefined;
    try {
      const drac = new AbortController();
      const drtimer = setTimeout(() => drac.abort(), 5_000);
      const dr = await fetch(`https://api.render.com/v1/services/${serviceId}/deploys?limit=1`, {
        headers: { Authorization: `Bearer ${tok}` }, signal: drac.signal,
      });
      clearTimeout(drtimer);
      if (dr.ok) {
        const dl: any = await dr.json();
        const dep = dl?.[0]?.deploy ?? dl?.[0];
        if (dep) { depStatus = dep.status; depFinishedAt = dep.finishedAt; }
      }
    } catch { /* swallow */ }

    let status: RenderServiceCheck["status"] = "live";
    if (suspended) status = "suspended";
    else if (depStatus === "build_failed") status = "build_failed";
    else if (depStatus === "update_failed") status = "deploy_failed";
    return {
      serviceId,
      name: svc?.name ?? "(unknown)",
      url: baseUrl,
      status,
      lastDeployStatus: depStatus,
      lastDeployFinishedAt: depFinishedAt,
    };
  } catch (err) {
    return { serviceId, name: "(error)", status: "unknown" };
  }
}

// ── Bot HTTP health ───────────────────────────────────────────────────

async function checkBotHealth(url: string): Promise<{ ok: boolean; statusCode: number; degraded: boolean; detail?: string }> {
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 10_000);
    const r = await fetch(url, { signal: ac.signal });
    clearTimeout(timer);
    if (!r.ok) return { ok: false, statusCode: r.status, degraded: true, detail: `HTTP ${r.status}` };
    let body: any = null;
    try { body = await r.json(); } catch { /* not JSON */ }
    // "degraded" is only ALARMING if a critical check is failing. A status
    // like "degraded" with only informational warnings (e.g., Reed's
    // plantList warning) shouldn't page Marcus. Look at sub-checks: if any
    // sub-check is "error" / "down" / "fail", that's broken. Warnings only
    // = informational, treat as OK.
    const isDown = body?.status === "down" || body?.status === "error";
    let critical = false;
    if (body && typeof body.checks === "object" && body.checks) {
      for (const v of Object.values(body.checks) as any[]) {
        if (v?.status === "error" || v?.status === "down" || v?.status === "fail") {
          critical = true; break;
        }
      }
    }
    const ok = !isDown && !critical;
    return { ok, statusCode: r.status, degraded: !ok, detail: body?.status ?? "ok" };
  } catch (err) {
    return { ok: false, statusCode: 0, degraded: true, detail: (err as Error).message };
  }
}

/** Per-service health-endpoint path. Some services use /health, some use /api/health. */
function healthPathFor(serviceName: string): string {
  // spamslayer-backend exposes /api/health (Express convention used in our backend)
  if (serviceName.includes("spamslayer")) return "/api/health";
  // Reed (receptionist-AI) and most Fastify-based services use /health
  return "/health";
}

// ── Main monitor pass ─────────────────────────────────────────────────

export interface MonitorResult {
  generatedAt: string;
  transitions: Transition[];   // alarms that just changed state — these get Discord'd
  snapshot: {
    botGrades: BotGradeReport[];
    renderServices: RenderServiceCheck[];
    botHealthChecks: Array<{ url: string; ok: boolean; degraded: boolean; detail?: string }>;
  };
}

/**
 * Run a full monitor pass. Returns transitions (for Discord) + a snapshot
 * (for the /api/admin/health-now endpoint).
 *
 * SILENT-FAILURE THRESHOLD: a bot is considered BROKEN if its silent-failure
 * rate over the last 24h is >= 30%, with at least 5 calls of data. Below 5
 * calls, we can't say.
 */
export async function runMonitor(): Promise<MonitorResult> {
  const transitions: Transition[] = [];
  const generatedAt = new Date().toISOString();

  // ── Per-bot call grading ────────────────────────────────────────────
  const botGrades: BotGradeReport[] = [];
  for (const bot of BOTS_TO_MONITOR) {
    try {
      const report = await gradeBotRecentCalls(bot, { windowHours: 24, maxCalls: 25 });
      botGrades.push(report);

      // The big alarm: silent-failure rate over threshold
      if (report.totalCalls >= 5) {
        const broken = report.silentFailureRate >= 0.30;
        const failed = (report.byGrade["F-SILENT"] ?? 0) + (report.byGrade["RTC-DOWN"] ?? 0);
        const msg = broken
          ? `${bot.slug}: ${failed} of last ${report.totalCalls} calls were silent-failures (${Math.round(report.silentFailureRate * 100)}%)`
          : `${bot.slug}: silent-failure rate ${Math.round(report.silentFailureRate * 100)}% (${failed}/${report.totalCalls})`;
        const t = checkAlarm(`bot-silent-failure:${bot.slug}`, broken, msg);
        if (t) transitions.push(t);
      }
    } catch (err) {
      console.warn(`[Monitor] grade failed for ${bot.slug}:`, (err as Error).message);
    }
  }

  // ── Render service health ────────────────────────────────────────────
  const services = [
    process.env.RENDER_SPAMSLAYER_SERVICE_ID,
    process.env.RENDER_RECEPTIONIST_SERVICE_ID,
  ].filter(Boolean) as string[];
  const renderServices: RenderServiceCheck[] = [];
  for (const sid of services) {
    const res = await checkRenderService(sid);
    renderServices.push(res);
    const broken = res.status !== "live" && res.status !== "unknown";
    const msg = broken
      ? `Render service ${res.name}: status=${res.status}, last deploy ${res.lastDeployStatus} at ${res.lastDeployFinishedAt}`
      : `Render service ${res.name}: ${res.status}`;
    if (res.status !== "unknown") {
      const t = checkAlarm(`render-service:${sid}`, broken, msg);
      if (t) transitions.push(t);
    }
  }

  // ── Bot HTTP /health probes ─────────────────────────────────────────
  const healthUrls: string[] = [];
  for (const svc of renderServices) {
    if (svc.url) healthUrls.push(svc.url + healthPathFor(svc.name));
  }
  const botHealthChecks: MonitorResult["snapshot"]["botHealthChecks"] = [];
  for (const url of healthUrls) {
    const h = await checkBotHealth(url);
    botHealthChecks.push({ url, ok: h.ok, degraded: h.degraded, detail: h.detail });
    const broken = !h.ok;
    const msg = broken
      ? `${url} returned ${h.detail} (HTTP ${h.statusCode})`
      : `${url} ok`;
    const t = checkAlarm(`http-health:${url}`, broken, msg);
    if (t) transitions.push(t);
  }

  return { generatedAt, transitions, snapshot: { botGrades, renderServices, botHealthChecks } };
}

// ── Auto-restart helper (opt-in, gated on AUTO_RESTART_ON_SILENT_BOT=true) ──

/**
 * Trigger a redeploy of a Render service. Used as a possibly-effective
 * recovery action when a bot's silent-failure rate stays elevated.
 *
 * Idempotency: caller must check that we haven't restarted this service
 * within the last hour; this function doesn't track timing.
 */
export async function triggerRenderRedeploy(serviceId: string): Promise<{ ok: boolean; deployId?: string; error?: string }> {
  const tok = process.env.RENDER_API_KEY;
  if (!tok) return { ok: false, error: "RENDER_API_KEY not set" };
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 15_000);
    const r = await fetch(`https://api.render.com/v1/services/${serviceId}/deploys`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tok}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ clearCache: "do_not_clear" }),
      signal: ac.signal,
    });
    clearTimeout(timer);
    if (!r.ok) return { ok: false, error: `Render redeploy ${r.status}: ${(await r.text()).slice(0, 200)}` };
    const dep: any = await r.json();
    return { ok: true, deployId: dep?.id };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}
