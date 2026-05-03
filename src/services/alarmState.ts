// ─────────────────────────────────────────────────────────────────────────────
//  alarmState.ts — disk-persisted "what's currently broken" state
//
//  The healthMonitor scans every 5 min. Without state tracking, every scan
//  would Discord-spam the same failure indefinitely. With state tracking,
//  we only fire on TRANSITIONS:
//    OK → BROKEN   → 🔴 "X just broke" embed
//    BROKEN → OK   → ✅ "X recovered (down for Nm)" embed
//    same state    → no message
//
//  Persisted to disk so we don't false-recover across container restarts.
// ─────────────────────────────────────────────────────────────────────────────

import * as fs from "fs";
import * as path from "path";

export type AlarmStatus = "ok" | "broken";

export interface AlarmEntry {
  status: AlarmStatus;
  /** First detected at this timestamp (when transitioned to BROKEN). */
  brokenSince?: string;
  /** Last update timestamp. */
  lastChecked: string;
  /** Last alarm message — used to detect "still broken but message changed". */
  lastMessage?: string;
}

const STATE_FILE = path.resolve(__dirname, "..", "..", "..", "alarm_state.json");
const STATE_TEMP = STATE_FILE + ".tmp";

function load(): Record<string, AlarmEntry> {
  if (!fs.existsSync(STATE_FILE)) return {};
  try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf-8")) as Record<string, AlarmEntry>; }
  catch { return {}; }
}

function save(s: Record<string, AlarmEntry>): void {
  try {
    fs.writeFileSync(STATE_TEMP, JSON.stringify(s, null, 2), { encoding: "utf-8", mode: 0o600 });
    fs.renameSync(STATE_TEMP, STATE_FILE);
  } catch (err) {
    console.warn("[AlarmState] save failed:", (err as Error).message);
  }
}

export interface Transition {
  alarmId: string;
  from: AlarmStatus | "new";
  to: AlarmStatus;
  message: string;
  brokenSince?: string;
  durationMs?: number;     // populated on broken→ok recoveries
}

/**
 * Apply the latest check result for one alarm. Returns a Transition object
 * if the state changed (broke or recovered), else null.
 */
export function checkAlarm(alarmId: string, currentlyBroken: boolean, message: string): Transition | null {
  const state = load();
  const prev = state[alarmId];
  const now = new Date().toISOString();
  const newStatus: AlarmStatus = currentlyBroken ? "broken" : "ok";

  let transition: Transition | null = null;

  if (!prev) {
    // First time seeing this alarm. Only emit if currently broken.
    if (currentlyBroken) {
      transition = { alarmId, from: "new", to: "broken", message, brokenSince: now };
    }
    state[alarmId] = {
      status: newStatus,
      brokenSince: currentlyBroken ? now : undefined,
      lastChecked: now,
      lastMessage: message,
    };
  } else if (prev.status !== newStatus) {
    if (newStatus === "broken") {
      transition = { alarmId, from: "ok", to: "broken", message, brokenSince: now };
      state[alarmId] = { status: "broken", brokenSince: now, lastChecked: now, lastMessage: message };
    } else {
      // recovered
      const durationMs = prev.brokenSince
        ? Date.now() - new Date(prev.brokenSince).getTime()
        : 0;
      transition = { alarmId, from: "broken", to: "ok", message, durationMs };
      state[alarmId] = { status: "ok", lastChecked: now, lastMessage: message };
    }
  } else {
    // no transition — just update lastChecked
    state[alarmId] = { ...prev, lastChecked: now, lastMessage: message };
  }

  save(state);
  return transition;
}

/** Read-only snapshot for the dashboard. */
export function getAlarmState(): Record<string, AlarmEntry> {
  return load();
}

export function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const mr = m % 60;
  return `${h}h ${mr}m`;
}
