// ─────────────────────────────────────────────────────────────────────────────
//  callSession.ts — in-memory + disk-snapshotted state for active spam calls
//
//  Each session tracks everything about one spam call: who called, what they
//  said, what company they represent, and whether the DNC warning was delivered.
//
//  P2.2: snapshot the live sessions Map to disk on every mutation, hydrate
//  on startup. Without this, a process restart mid-call (Render container
//  recycle, deploy, OOM) loses the session entirely — the next webhook from
//  Twilio sees an empty Map and the call dies as "Sorry, I'm having trouble."
//  Sessions older than 5 minutes on hydrate are dropped (stale call).
// ─────────────────────────────────────────────────────────────────────────────

import * as fs from "fs";
import * as path from "path";

export interface CallSession {
  callSid: string;
  callerPhone: string;       // the spammer's number
  subscriberPhone: string;   // our user who forwarded the call
  subscriberId: string;      // user account ID
  subscriberName: string | null;  // passed from Reed's skill config
  subscriberSex: "M" | "F" | null; // passed from Reed's skill config
  turns: Array<{ role: "caller" | "sam"; text: string }>;
  extractedCompany: string | null;
  extractedCallerName: string | null;
  extractedPurpose: string | null;
  warningDelivered: boolean;
  startTime: Date;
  recordingUrl: string | null;
  recordingSid: string | null;
}

const SESSIONS_FILE = path.resolve(__dirname, "..", "..", "..", "call_sessions.json");
const SESSIONS_TEMP = SESSIONS_FILE + ".tmp";
const STALE_AFTER_MS = 5 * 60 * 1000; // 5 minutes — Twilio call max is 4hrs but spam calls are <1m

const sessions = new Map<string, CallSession>();

function snapshotToDisk(): void {
  // Serialize Date → ISO string for JSON. On hydrate we rebuild Date.
  try {
    const obj: Record<string, unknown> = {};
    for (const [k, v] of sessions) {
      obj[k] = { ...v, startTime: v.startTime.toISOString() };
    }
    fs.writeFileSync(SESSIONS_TEMP, JSON.stringify(obj), { encoding: "utf-8", mode: 0o600 });
    try { fs.chmodSync(SESSIONS_TEMP, 0o600); } catch { /* best-effort */ }
    fs.renameSync(SESSIONS_TEMP, SESSIONS_FILE);
    try { fs.chmodSync(SESSIONS_FILE, 0o600); } catch { /* best-effort */ }
  } catch (err) {
    // Snapshot failures must NEVER kill a live call. Log and move on.
    console.warn(`[CallSession] snapshot failed (${(err as Error).message}); in-memory state retained, restart will lose it.`);
  }
}

function hydrateFromDisk(): void {
  if (!fs.existsSync(SESSIONS_FILE)) return;
  let raw: string;
  try { raw = fs.readFileSync(SESSIONS_FILE, "utf-8"); }
  catch (err) {
    console.warn(`[CallSession] hydrate read failed: ${(err as Error).message}`);
    return;
  }
  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(raw) as Record<string, unknown>; }
  catch (err) {
    console.warn(`[CallSession] hydrate parse failed: ${(err as Error).message}; deleting corrupt sessions file`);
    try { fs.unlinkSync(SESSIONS_FILE); } catch { /* ignore */ }
    return;
  }
  const now = Date.now();
  let loaded = 0;
  let dropped = 0;
  for (const [k, vRaw] of Object.entries(parsed)) {
    const v = vRaw as Record<string, unknown>;
    const startIso = typeof v.startTime === "string" ? v.startTime : null;
    if (!startIso) { dropped++; continue; }
    const startDate = new Date(startIso);
    if (isNaN(startDate.getTime()) || (now - startDate.getTime()) > STALE_AFTER_MS) {
      dropped++;
      continue;
    }
    sessions.set(k, { ...(v as unknown as CallSession), startTime: startDate });
    loaded++;
  }
  if (loaded || dropped) {
    console.log(`[CallSession] hydrated ${loaded} active session(s), dropped ${dropped} stale session(s)`);
  }
}

// Hydrate on module load — runs once when Express boots.
hydrateFromDisk();

export function getOrCreate(
  callSid: string,
  callerPhone: string,
  subscriberPhone: string,
  subscriberId: string,
  subscriberName: string | null = null,
  subscriberSex: "M" | "F" | null = null
): CallSession {
  if (!sessions.has(callSid)) {
    sessions.set(callSid, {
      callSid,
      callerPhone,
      subscriberPhone,
      subscriberId,
      subscriberName,
      subscriberSex,
      turns: [],
      extractedCompany: null,
      extractedCallerName: null,
      extractedPurpose: null,
      warningDelivered: false,
      startTime: new Date(),
      recordingUrl: null,
      recordingSid: null,
    });
    snapshotToDisk();
  }
  return sessions.get(callSid)!;
}

export function get(callSid: string): CallSession | undefined {
  return sessions.get(callSid);
}

export function addTurn(callSid: string, role: "caller" | "sam", text: string): void {
  const s = sessions.get(callSid);
  if (!s) return;
  s.turns.push({ role, text });
  // Keep last 10 turns to limit prompt size
  if (s.turns.length > 10) s.turns.splice(0, s.turns.length - 10);
  snapshotToDisk();
}

export function updateExtracted(
  callSid: string,
  data: Partial<Pick<CallSession, "extractedCompany" | "extractedCallerName" | "extractedPurpose">>
): void {
  const s = sessions.get(callSid);
  if (!s) return;
  if (data.extractedCompany !== undefined) s.extractedCompany = data.extractedCompany;
  if (data.extractedCallerName !== undefined) s.extractedCallerName = data.extractedCallerName;
  if (data.extractedPurpose !== undefined) s.extractedPurpose = data.extractedPurpose;
  snapshotToDisk();
}

export function markWarningDelivered(callSid: string): void {
  const s = sessions.get(callSid);
  if (s) {
    s.warningDelivered = true;
    snapshotToDisk();
  }
}

export function setRecording(callSid: string, url: string, sid: string): void {
  const s = sessions.get(callSid);
  if (!s) return;
  s.recordingUrl = url;
  s.recordingSid = sid;
  snapshotToDisk();
}

export function remove(callSid: string): void {
  if (sessions.delete(callSid)) snapshotToDisk();
}

/** Typed log entry for JSON storage / case building. */
export interface LogEntry {
  callSid: string;
  callerPhone: string;
  subscriberPhone: string;
  subscriberId: string;
  turns: Array<{ role: "caller" | "sam"; text: string }>;
  extractedCompany: string | null;
  extractedCallerName: string | null;
  extractedPurpose: string | null;
  warningDelivered: boolean;
  startTime: string;
  endTime: string;
  durationSeconds: number;
  recordingUrl: string | null;
  recordingSid: string | null;
}

/** Flatten session into a typed object for JSON storage / case building. */
export function toLogEntry(callSid: string): LogEntry | null {
  const s = sessions.get(callSid);
  if (!s) return null;
  return {
    callSid: s.callSid,
    callerPhone: s.callerPhone,
    subscriberPhone: s.subscriberPhone,
    subscriberId: s.subscriberId,
    turns: s.turns.map((t) => ({ role: t.role, text: t.text })),
    extractedCompany: s.extractedCompany,
    extractedCallerName: s.extractedCallerName,
    extractedPurpose: s.extractedPurpose,
    warningDelivered: s.warningDelivered,
    startTime: s.startTime.toISOString(),
    endTime: new Date().toISOString(),
    durationSeconds: Math.round((Date.now() - s.startTime.getTime()) / 1000),
    recordingUrl: s.recordingUrl,
    recordingSid: s.recordingSid,
  };
}
